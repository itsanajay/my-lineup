// My Lineup: a retro TV guide for the shows you follow.
// Show and episode data comes from the free TVmaze API (https://www.tvmaze.com/api).
// Everything the user saves lives in this browser's localStorage.

const API = 'https://api.tvmaze.com';
const SHOWS_KEY = 'lineup.shows';
const CACHE_PREFIX = 'lineup.cache.';
const CACHE_MS = 6 * 60 * 60 * 1000;
const PRIME_TIME = [20, 21, 22];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const LONG_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const state = {
  tab: 'guide',
  weekOffset: 0,
  day: ymd(new Date()),
  picked: null,
  details: {},       // show id -> TVmaze show with embedded episodes
  loading: false,
  loadError: false,
  query: '',
  results: null,
  searching: false,
  searchError: false,
};

// ---------- storage ----------

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // Storage full or blocked: the app still works for this visit.
  }
}

function myShows() {
  return readJSON(SHOWS_KEY, []);
}

function saveMyShows(list) {
  writeJSON(SHOWS_KEY, list);
}

// ---------- dates ----------

function pad(n) {
  return String(n).padStart(2, '0');
}

function ymd(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function weekDays(offset) {
  const today = new Date();
  const monday = addDays(today, -((today.getDay() + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

function hourLabel(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  return ((h + 11) % 12 + 1) + ' ' + suffix;
}

function shortDate(d) {
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

// Streaming drops usually have no air time, so they land in the "NEW TODAY" slot
// on their release date. Timed episodes use the viewer's local clock.
function episodeDay(ep) {
  if (!ep.airtime && ep.airdate) return ep.airdate;
  if (ep.airstamp) return ymd(new Date(ep.airstamp));
  return ep.airdate || null;
}

function episodeSlot(ep) {
  if (!ep.airtime || !ep.airstamp) return 'new';
  return new Date(ep.airstamp).getHours();
}

function slotLabel(slot) {
  return slot === 'new' ? 'NEW TODAY' : hourLabel(slot);
}

// ---------- data ----------

function channelOf(show) {
  if (show.webChannel && show.webChannel.name) return show.webChannel.name;
  if (show.network && show.network.name) return show.network.name;
  return 'Other';
}

async function getJSON(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error('TVmaze ' + res.status);
  return res.json();
}

async function loadShow(id, force) {
  const cached = readJSON(CACHE_PREFIX + id, null);
  if (cached && !force && Date.now() - cached.at < CACHE_MS) return cached.data;
  try {
    const data = await getJSON('/shows/' + id + '?embed[]=episodes&embed[]=nextepisode');
    writeJSON(CACHE_PREFIX + id, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;
    throw e;
  }
}

async function refreshAll() {
  const list = myShows();
  if (!list.length) return;
  state.loading = true;
  state.loadError = false;
  render();
  // TVmaze allows about 20 calls every 10 seconds, so load a few at a time.
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i + 4);
    const loaded = await Promise.allSettled(batch.map((s) => loadShow(s.id)));
    loaded.forEach((r, j) => {
      if (r.status === 'fulfilled') state.details[batch[j].id] = r.value;
      else state.loadError = true;
    });
  }
  state.loading = false;
  render();
}

function nextEpisode(show) {
  return show._embedded && show._embedded.nextepisode ? show._embedded.nextepisode : null;
}

function episodesOf(show) {
  return (show._embedded && show._embedded.episodes) || [];
}

function epCode(eps) {
  const first = eps[0];
  if (eps.length === 1) return 'S' + first.season + ' · E' + first.number;
  const last = eps[eps.length - 1];
  return 'S' + first.season + ' · E' + first.number + '–' + last.number;
}

// Shows with nothing in the next week wait on the "Returning soon" shelf
// and move back into the guide once a new episode is dated.
function returningSoon() {
  const soon = addDays(new Date(), 7);
  return myShows()
    .map((s) => state.details[s.id])
    .filter(Boolean)
    .filter((show) => {
      const next = nextEpisode(show);
      return !next || !next.airdate || parseYmd(next.airdate) > soon;
    })
    .map((show) => {
      const next = nextEpisode(show);
      let when = 'DATE TBA';
      let tba = true;
      if (next && next.airdate) {
        when = shortDate(parseYmd(next.airdate));
        tba = false;
      } else if (show.status === 'Ended') {
        when = 'ENDED';
      }
      const season = next ? 'Season ' + next.season : show.status === 'Ended' ? 'Series over' : 'Next season';
      return { name: show.name, season, when, tba, sort: next && next.airdate ? next.airdate : '9999' };
    })
    .sort((a, b) => a.sort.localeCompare(b.sort));
}

function guideFor(day) {
  const shows = myShows().map((s) => state.details[s.id]).filter(Boolean);
  const channels = [...new Set(shows.map(channelOf))].sort((a, b) => a.localeCompare(b));

  const entries = [];
  shows.forEach((show) => {
    const todays = episodesOf(show).filter((ep) => episodeDay(ep) === day);
    const bySlot = {};
    todays.forEach((ep) => {
      const slot = episodeSlot(ep);
      (bySlot[slot] = bySlot[slot] || []).push(ep);
    });
    Object.keys(bySlot).forEach((key) => {
      const eps = bySlot[key].sort((a, b) => a.number - b.number);
      const slot = key === 'new' ? 'new' : Number(key);
      entries.push({
        key: show.id + '|' + day + '|' + key,
        channel: channelOf(show),
        slot,
        title: show.name,
        code: epCode(eps),
        epName: eps.length === 1 ? eps[0].name : eps.length + ' episodes',
      });
    });
  });

  const hours = [...new Set(entries.filter((e) => e.slot !== 'new').map((e) => e.slot))];
  PRIME_TIME.forEach((h) => {
    if (hours.length < 3 && !hours.includes(h)) hours.push(h);
  });
  hours.sort((a, b) => a - b);
  const slots = ['new', ...hours];

  // One row per channel; a second row for the same channel only when two shows share a slot.
  const rows = [];
  channels.forEach((channel, i) => {
    const num = pad(2 + i * 2);
    const mine = entries.filter((e) => e.channel === channel);
    const chanRows = [{ channel, num, cells: {} }];
    mine.forEach((e) => {
      let row = chanRows.find((r) => !r.cells[e.slot]);
      if (!row) {
        row = { channel, num, cells: {} };
        chanRows.push(row);
      }
      row.cells[e.slot] = e;
    });
    rows.push(...chanRows);
  });

  return { slots, rows, entries };
}

// ---------- rendering ----------

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderGuide() {
  const list = myShows();
  if (!list.length) {
    return `
      <div class="empty">
        <div class="big">YOUR GUIDE IS EMPTY</div>
        <p class="hint">Search for the shows you watch and they'll fill in here on the days new episodes come out.</p>
        <button class="btn" type="button" data-action="tab" data-tab="search">FIND A SHOW</button>
      </div>`;
  }

  const todayKey = ymd(new Date());
  const days = weekDays(state.weekOffset);
  const dayButtons = days.map((d) => {
    const key = ymd(d);
    const cls = 'day' + (key === todayKey ? ' today' : '');
    return `<button type="button" class="${cls}" aria-pressed="${key === state.day}" data-action="day" data-day="${key}" aria-label="${LONG_DAYS[d.getDay()]} ${shortDate(d)}">
      <span class="d-short">${DAY_NAMES[d.getDay()]}</span><span class="d-num">${d.getDate()}</span></button>`;
  }).join('');

  const { slots, rows, entries } = guideFor(state.day);
  let picked = entries.find((e) => e.key === state.picked) || entries[0] || null;

  const head = `<div class="g-row g-head"><div class="g-chan">CHANNEL</div>${slots
    .map((s) => `<div class="g-slot">${slotLabel(s)}</div>`).join('')}</div>`;

  const body = rows.map((row) => {
    const cells = slots.map((slot) => {
      const e = row.cells[slot];
      if (!e) return '<div class="cell-empty">Nothing new</div>';
      const on = picked && picked.key === e.key;
      return `<button type="button" class="cell" aria-pressed="${on}" data-action="pick" data-key="${esc(e.key)}">
        <span class="t">${esc(e.title)}</span><span class="e">${esc(e.code)}</span></button>`;
    }).join('');
    return `<div class="g-row"><div class="g-chan"><span class="num">${row.num}</span><span class="name">${esc(row.channel.toUpperCase())}</span></div>${cells}</div>`;
  }).join('');

  const dayDate = parseYmd(state.day);
  const selected = picked
    ? `<section class="selected" aria-label="Selected show">
        <span class="when">NEW ON ${esc(picked.channel.toUpperCase())} · ${DAY_NAMES[dayDate.getDay()]}${picked.slot === 'new' ? '' : ' ' + slotLabel(picked.slot)}</span>
        <span class="title">${esc(picked.title)}</span>
        <span class="ep">${esc(picked.code)}${picked.epName ? ' · ' + esc(picked.epName) : ''}</span>
      </section>`
    : `<section class="selected" aria-label="Selected show">
        <span class="when">${LONG_DAYS[dayDate.getDay()]}</span>
        <span class="title">Nothing new today</span>
      </section>`;

  const shelf = returningSoon();
  const shelfHtml = shelf.length
    ? `<section class="section" aria-label="Returning soon">
        <div class="section-title">RETURNING SOON</div>
        <div class="shelf">${shelf.map((s) => `
          <div class="shelf-card"><span class="t">${esc(s.name)}</span><span class="s">${esc(s.season)}</span>
          <span class="d${s.tba ? ' tba' : ''}">${esc(s.when)}</span></div>`).join('')}</div>
      </section>`
    : '';

  const status = state.loading
    ? '<p class="hint section">Tuning in…</p>'
    : state.loadError
      ? '<p class="hint section error">Some shows couldn\'t load. Check your connection and reopen the app.</p>'
      : '';

  return `
    <nav class="week" aria-label="Day">
      <button type="button" class="week-arrow" data-action="week" data-dir="-1" aria-label="Previous week">‹</button>
      ${dayButtons}
      <button type="button" class="week-arrow" data-action="week" data-dir="1" aria-label="Next week">›</button>
    </nav>
    <div class="grid-wrap"><div class="grid">${head}${body}</div></div>
    ${selected}
    ${status}
    ${shelfHtml}`;
}

function showStatus(show) {
  if (!show) return 'Loading…';
  const next = nextEpisode(show);
  if (next && next.airdate) {
    const d = parseYmd(next.airdate);
    const soon = d <= addDays(new Date(), 7);
    return (soon ? 'Next: ' : 'Returning ') + DAY_NAMES[d.getDay()] + ' ' + shortDate(d) + ' · S' + next.season + ' E' + next.number;
  }
  if (show.status === 'Ended') return 'Series has ended';
  return 'Off-season · date TBA';
}

function renderShows() {
  const list = myShows();
  if (!list.length) {
    return `
      <div class="empty">
        <div class="big">NO SHOWS YET</div>
        <p class="hint">Add the shows you follow and we'll keep track of when new episodes drop.</p>
        <button class="btn" type="button" data-action="tab" data-tab="search">FIND A SHOW</button>
      </div>`;
  }
  const items = list.map((s) => {
    const show = state.details[s.id];
    return `<div class="item">
      <div class="info">
        <span class="t">${esc(s.name)}</span>
        <span class="s">${esc(s.channel)}</span>
        <span class="n">${esc(showStatus(show))}</span>
      </div>
      <button type="button" class="btn ghost" data-action="remove" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">REMOVE</button>
    </div>`;
  }).join('');
  return `<section class="section"><div class="section-title">MY SHOWS</div><div class="list">${items}</div>
    <p class="hint">Show data from <a href="https://www.tvmaze.com" style="color: var(--yellow)">TVmaze</a>.</p></section>`;
}

function renderSearch() {
  const tracked = new Set(myShows().map((s) => s.id));
  let results = '';
  if (state.searching) {
    results = '<p class="hint">Searching…</p>';
  } else if (state.searchError) {
    results = '<p class="hint error">Search isn\'t working right now. Check your connection and try again.</p>';
  } else if (state.results && !state.results.length) {
    results = '<p class="hint">No shows found. Try a different spelling.</p>';
  } else if (state.results) {
    results = '<div class="list">' + state.results.map(({ show }) => {
      const added = tracked.has(show.id);
      const year = show.premiered ? show.premiered.slice(0, 4) : '';
      const img = show.image && show.image.medium
        ? `<img src="${esc(show.image.medium)}" alt="" loading="lazy">`
        : '<div class="poster" aria-hidden="true"></div>';
      return `<div class="item">
        ${img}
        <div class="info">
          <span class="t">${esc(show.name)}</span>
          <span class="s">${esc(channelOf(show))}${year ? ' · ' + year : ''}${show.status ? ' · ' + esc(show.status) : ''}</span>
        </div>
        <button type="button" class="btn${added ? ' ghost' : ''}" data-action="add" data-id="${show.id}" ${added ? 'disabled' : ''}>${added ? 'ADDED' : '+ ADD'}</button>
      </div>`;
    }).join('') + '</div>';
  }
  return `
    <section class="section">
      <form class="list" data-action="search" role="search">
        <label class="cap" for="q">FIND A SHOW TO ADD</label>
        <div class="search-box">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffd23f" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>
          <input id="q" type="search" name="q" placeholder="Type a title" autocomplete="off" value="${esc(state.query)}">
        </div>
      </form>
      ${results}
    </section>`;
}

function render() {
  const view = document.getElementById('view');
  const hadFocus = document.activeElement && document.activeElement.id === 'q';
  const caret = hadFocus ? document.activeElement.selectionStart : null;

  view.innerHTML = state.tab === 'guide' ? renderGuide() : state.tab === 'shows' ? renderShows() : renderSearch();

  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  const d = parseYmd(state.day);
  document.getElementById('top-date').textContent =
    state.tab === 'guide' ? DAY_NAMES[d.getDay()] + ', ' + shortDate(d) : '';

  if (hadFocus) {
    const q = document.getElementById('q');
    if (q) {
      q.focus();
      q.setSelectionRange(caret, caret);
    }
  }
}

// ---------- actions ----------

let searchTimer = null;
let searchSeq = 0;

async function runSearch(q) {
  state.query = q;
  if (!q.trim()) {
    state.results = null;
    render();
    return;
  }
  const seq = ++searchSeq;
  state.searching = true;
  state.searchError = false;
  render();
  try {
    const results = await getJSON('/search/shows?q=' + encodeURIComponent(q.trim()));
    if (seq !== searchSeq) return;
    state.results = results;
  } catch (e) {
    if (seq !== searchSeq) return;
    state.searchError = true;
  }
  state.searching = false;
  render();
}

async function addShow(id) {
  const hit = (state.results || []).find((r) => r.show.id === id);
  if (!hit) return;
  const list = myShows();
  if (list.some((s) => s.id === id)) return;
  list.push({ id, name: hit.show.name, channel: channelOf(hit.show) });
  saveMyShows(list);
  render();
  try {
    state.details[id] = await loadShow(id, true);
  } catch (e) {
    state.loadError = true;
  }
  render();
}

function removeShow(id) {
  saveMyShows(myShows().filter((s) => s.id !== id));
  delete state.details[id];
  try { localStorage.removeItem(CACHE_PREFIX + id); } catch (e) { /* ignore */ }
  render();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM') return;
  const action = el.dataset.action;
  if (action === 'tab') {
    state.tab = el.dataset.tab;
    render();
  } else if (action === 'day') {
    state.day = el.dataset.day;
    state.picked = null;
    render();
  } else if (action === 'week') {
    state.weekOffset += Number(el.dataset.dir);
    const days = weekDays(state.weekOffset);
    const todayKey = ymd(new Date());
    state.day = state.weekOffset === 0 && days.some((d) => ymd(d) === todayKey) ? todayKey : ymd(days[0]);
    state.picked = null;
    render();
  } else if (action === 'pick') {
    state.picked = el.dataset.key;
    render();
  } else if (action === 'add') {
    addShow(Number(el.dataset.id));
  } else if (action === 'remove') {
    removeShow(Number(el.dataset.id));
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const q = ev.target.value;
  state.query = q;
  searchTimer = setTimeout(() => runSearch(q), 350);
});

document.addEventListener('submit', (ev) => {
  if (ev.target.dataset.action !== 'search') return;
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch(ev.target.q.value);
});

render();
refreshAll();
