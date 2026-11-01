/* Load nearby footage; loop every video and play all visible experiments. */
(() => {
  'use strict';
  const config = window.PROJECT_LINKS || {};
  document.querySelectorAll('[data-resource]').forEach(link => {
    const value = config[link.dataset.resource];
    if (!value) return;
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol)) return;
      Object.assign(link, {href: url.href, target: '_blank', rel: 'noopener noreferrer'});
      ['aria-disabled','tabindex','title'].forEach(attr => link.removeAttribute(attr));
    } catch (_) { /* An empty or invalid resource remains inactive. */ }
  });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const automatic = !reducedMotion && !navigator.connection?.saveData;
  const videos = [...document.querySelectorAll('video[data-src]')];
  const independentVideos = videos.filter(video => !video.dataset.syncGroup);
  document.querySelectorAll('video').forEach(video => { video.loop = true; });
  const visible = new Map(), userPaused = new WeakSet(), internalPause = new WeakSet();
  const loading = new WeakSet();
  const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  let scheduled = false;
  function load(video) {
    if (video.hasAttribute('src') || loading.has(video)) return;
    const previewFilm = localPreview && video.id === 'project-film';
    if ((video.dataset.syncGroup || previewFilm) && location.protocol !== 'file:') {
      // Fully buffer short pairs so synchronized seeking also works on static
      // preview servers that do not support HTTP Range requests.
      // Buffer the full film only on localhost; deployed pages stream it normally.
      loading.add(video); video.preload = 'auto';
      fetch(video.dataset.src).then(response => {
        if (!response.ok) throw new Error('Video request failed');
        return response.blob();
      }).then(blob => {
        video.src = URL.createObjectURL(blob); video.load(); schedulePlayback();
      }).catch(() => video.dispatchEvent(new Event('error')));
      return;
    }
    video.preload = 'metadata'; video.src = video.dataset.src; video.load();
  }
  function pause(video) {
    if (video.paused) return;
    internalPause.add(video); video.pause();
  }
  // Paired recordings share controls and a clock, including buffering and looping.
  function synchronizedGroup(members) {
    const leader = members[0];
    const expectedPause = new WeakSet(), expectedPlay = new WeakSet();
    const expectedSeek = new WeakMap();
    let wantsPlayback = false, manuallyPaused = false, starting = false, restarting = false, frame = 0, attempt = 0;
    let rate = 1;
    function stopMembers() {
      attempt++; starting = false;
      members.forEach(video => {
        if (!video.paused) { expectedPause.add(video); video.pause(); }
      });
      cancelAnimationFrame(frame); frame = 0;
    }
    function seek(video, time) {
      if (Math.abs(video.currentTime - time) < .015) return;
      expectedSeek.set(video, time); video.currentTime = time;
    }
    function watchClock() {
      frame = 0;
      if (!wantsPlayback || members.some(video => video.paused || video.seeking)) return;
      members.slice(1).forEach(video => {
        if (Math.abs(video.currentTime - leader.currentTime) > .08) seek(video, leader.currentTime);
      });
      frame = requestAnimationFrame(watchClock);
    }
    function resume() {
      if (!wantsPlayback || starting) return;
      members.forEach(load);
      if (members.some(video => video.readyState < 3 || video.seeking)) {
        stopMembers(); return;
      }
      members.slice(1).forEach(video => seek(video, leader.currentTime));
      if (members.some(video => video.seeking)) { stopMembers(); return; }
      if (members.every(video => !video.paused)) {
        if (!frame) frame = requestAnimationFrame(watchClock);
        return;
      }
      starting = true;
      restarting = false;
      const thisAttempt = ++attempt;
      Promise.allSettled(members.map(video => {
        video.playbackRate = rate;
        if (!video.paused) return Promise.resolve();
        expectedPlay.add(video);
        return video.play().catch(error => {
          if (error.name !== 'AbortError') expectedPlay.delete(video);
          throw error;
        });
      })).then(results => {
        if (thisAttempt !== attempt) return;
        starting = false;
        if (!wantsPlayback) stopMembers();
        else if (results.some(result => result.status === 'rejected')) {
          stopMembers();
          if (results.every(result => result.status === 'fulfilled' || result.reason?.name === 'AbortError')) resume();
        }
        else if (!frame) frame = requestAnimationFrame(watchClock);
      });
    }
    function seekTogether(time) {
      stopMembers(); members.forEach(video => seek(video, time)); resume();
    }
    members.forEach(video => {
      // A single restart barrier replaces two independent native loop restarts.
      video.loop = false;
      video.addEventListener('play', () => {
        if (expectedPlay.has(video)) { expectedPlay.delete(video); return; }
        manuallyPaused = false; wantsPlayback = true;
        members.forEach(load); resume();
      });
      video.addEventListener('pause', () => {
        if (expectedPause.has(video)) { expectedPause.delete(video); return; }
        if (video.ended || restarting) return;
        manuallyPaused = true; wantsPlayback = false; stopMembers();
      });
      video.addEventListener('seeking', () => {
        const target = expectedSeek.get(video);
        if (target !== undefined && Math.abs(video.currentTime - target) < .08) return;
        expectedSeek.delete(video);
        members.forEach(load);
        seekTogether(video.currentTime);
      });
      video.addEventListener('seeked', () => { expectedSeek.delete(video); resume(); });
      video.addEventListener('canplay', resume);
      video.addEventListener('waiting', () => { if (wantsPlayback) stopMembers(); });
      video.addEventListener('ratechange', () => {
        if (video.playbackRate === rate) return;
        rate = video.playbackRate;
        members.forEach(member => { member.playbackRate = rate; });
      });
    });
    leader.addEventListener('ended', () => {
      if (wantsPlayback) { restarting = true; seekTogether(0); }
    });
    return {
      members,
      get userPaused() { return manuallyPaused; },
      load() { members.forEach(load); },
      play() { wantsPlayback = true; resume(); },
      pause() { wantsPlayback = false; stopMembers(); }
    };
  }
  const grouped = new Map();
  videos.filter(video => video.dataset.syncGroup).forEach(video => {
    const key = video.dataset.syncGroup;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(video);
  });
  const syncGroups = [...grouped.values()].map(synchronizedGroup);
  const groupOf = new Map(syncGroups.flatMap(group => group.members.map(video => [video, group])));
  function updatePlayback() {
    scheduled = false;
    const candidates = automatic && !document.hidden
      ? [...visible].filter(([v, ratio]) => ratio >= .15 && !userPaused.has(v))
          .map(([v]) => v) : [];
    const active = new Set(candidates);
    independentVideos.forEach(video => {
      if (active.has(video)) { load(video); if (video.paused) video.play().catch(() => {}); }
      else if (automatic || document.hidden || (visible.get(video) || 0) === 0) pause(video);
    });
    syncGroups.forEach(group => {
      const onScreen = group.members.some(video => (visible.get(video) || 0) >= .15);
      if (document.hidden || !onScreen) group.pause();
      else if (automatic && !group.userPaused) group.play();
    });
  }
  function schedulePlayback() {
    if (!scheduled) { scheduled = true; requestAnimationFrame(updatePlayback); }
  }
  videos.forEach(video => {
    if (!groupOf.has(video)) {
      video.addEventListener('pause', () => {
        if (internalPause.has(video)) internalPause.delete(video);
        else if (!video.ended) userPaused.add(video);
      });
      video.addEventListener('play', () => userPaused.delete(video));
    }
    video.addEventListener('pointerdown', () => load(video), {once:true});
    video.addEventListener('keydown', () => load(video), {once:true});
    video.addEventListener('error', () => {
      const figure = video.closest('figure');
      if (figure.querySelector('.video-error')) return;
      const notice = document.createElement('p'); notice.className = 'video-error';
      notice.textContent = 'Video could not load. Please reload the page.'; figure.appendChild(notice);
    });
  });
  if ('IntersectionObserver' in window) {
    const nearby = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) {
        const group = groupOf.get(entry.target);
        if (group) group.load(); else load(entry.target);
        nearby.unobserve(entry.target);
      }
    }), {rootMargin:'220px 0px'});
    const inView = new IntersectionObserver(entries => {
      entries.forEach(entry => visible.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0));
      schedulePlayback();
    }, {threshold:[0,.15,.55,.85]});
    videos.forEach(video => { nearby.observe(video); inView.observe(video); });
  } else videos.forEach(load);
  document.addEventListener('visibilitychange', schedulePlayback);

  const teaser = document.getElementById('teaser'), control = document.getElementById('teaser-control');
  function updateTeaserLabel() {
    const label = teaser.paused ? 'Play' : 'Pause';
    control.textContent = label; control.setAttribute('aria-label', `${label} overview video`);
  }
  if (!automatic) teaser.pause();
  ['play','pause'].forEach(event => teaser.addEventListener(event, updateTeaserLabel));
  control.addEventListener('click', () => {
    if (teaser.paused) teaser.play().catch(() => {}); else teaser.pause();
  });
  let teaserWasPlaying = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { teaserWasPlaying = !teaser.paused; teaser.pause(); }
    else if (teaserWasPlaying && !teaser.ended) teaser.play().catch(() => {});
  });
  updateTeaserLabel();
  const dialog = document.getElementById('figure-dialog'), dialogImage = dialog.querySelector('img');
  let figureTrigger = null;
  document.querySelectorAll('[data-figure]').forEach(button => button.addEventListener('click', () => {
    figureTrigger = button; dialogImage.src = button.dataset.figure; dialogImage.alt = button.dataset.alt; dialog.showModal();
  }));
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => figureTrigger?.focus({preventScroll:true}));
})();
