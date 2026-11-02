// Local Listings: a retro TV guide for the shows you follow.
// Show and episode data comes from the free TVmaze API (https://www.tvmaze.com/api).
// Everything the user saves lives in this browser's localStorage.

const API = 'https://api.tvmaze.com';
const SHOWS_KEY = 'lineup.shows';
const CACHE_PREFIX = 'lineup.cache.';
const CACHE_MS = 6 * 60 * 60 * 1000;
const POOL_KEY = 'lineup.pool';
const SUBS_KEY = 'lineup.subs';
const TMDB_KEY = 'lineup.tmdbKey';
const PROV_PREFIX = 'lineup.prov.';
const PROV_MS = 24 * 60 * 60 * 1000;
const POOL_MS = 12 * 60 * 60 * 1000;
const PRIME_TIME = [20, 21, 22];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const LONG_DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

const state = {
  tab: 'guide',
  day: ymd(new Date()),
  calOpen: false,
  calMonth: null,    // first day of the month shown in the calendar
  picked: null,
  details: {},       // show id -> TVmaze show with embedded episodes
  loading: false,
  loadError: false,
  query: '',
  results: null,
  searching: false,
  searchError: false,
  providers: {},     // show id -> US streaming providers from TMDB, or null if none found
  pool: null,        // shows with new episodes this week, used for suggestions
  poolLoading: false,
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

function hourLabel(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  return ((h + 11) % 12 + 1) + ' ' + suffix;
}

function shortDate(d) {
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

function timeLabel(d) {
  const h = d.getHours();
  return ((h + 11) % 12 + 1) + ':' + pad(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM');
}

function slotLabel(slot) {
  return slot === 'new' ? 'NEW TODAY' : hourLabel(slot);
}

// A wall-clock time in US Eastern on a given date, as a Date in the viewer's own time zone.
function etDate(day, h, m) {
  const [y, mo, d] = day.split('-').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h + 5, m));
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(guess));
  let diff = etHour - h;
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return new Date(guess.getTime() - diff * 3600000);
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

// How a season comes out, read from its episode dates: one date for the whole
// season is a binge drop, a few dates is a split season, otherwise the gap
// between dates gives daily or weekly.
function seasonPattern(eps) {
  const dated = eps.filter((ep) => ep.airdate);
  const dates = [...new Set(dated.map((ep) => ep.airdate))].sort();
  if (dated.length < 2) return null;
  if (dates.length === 1) return 'ALL AT ONCE';
  if (dates.length <= 4 && dated.length / dates.length >= 2) return 'IN ' + dates.length + ' PARTS';
  const gaps = dates.slice(1).map((d, i) => Math.round((parseYmd(d) - parseYmd(dates[i])) / 86400000)).sort((a, b) => a - b);
  const gap = gaps[Math.floor(gaps.length / 2)];
  if (gap <= 3) return 'DAILY';
  if (gap >= 5 && gap <= 9) {
    const counts = {};
    dates.forEach((d) => { const w = parseYmd(d).getDay(); counts[w] = (counts[w] || 0) + 1; });
    const day = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    return 'WEEKLY · ' + LONG_DAYS[day] + 'S';
  }
  return null;
}

// Uses the upcoming season when enough of it is dated, else the latest season
// with dates, marked as last season's pattern.
function releasePattern(show) {
  const eps = episodesOf(show);
  if (!eps.length) return null;
  const next = nextEpisode(show);
  const seasons = [...new Set(eps.map((ep) => ep.season))].sort((a, b) => b - a);
  const current = next ? next.season : seasons[0];
  const now = seasonPattern(eps.filter((ep) => ep.season === current));
  if (now) return now;
  for (const season of seasons) {
    if (season >= current) continue;
    const before = seasonPattern(eps.filter((ep) => ep.season === season));
    if (before) return 'LAST SEASON: ' + before;
  }
  return null;
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
      return { name: show.name, season, when, tba, pattern: releasePattern(show), sort: next && next.airdate ? next.airdate : '9999' };
    })
    .sort((a, b) => a.sort.localeCompare(b.sort));
}

function guideFor(day) {
  const shows = myShows().map((s) => state.details[s.id]).filter(Boolean);
  const platforms = {};
  shows.forEach((show) => { platforms[show.id] = platformFor(show); });
  const channels = [...new Set(shows.map((show) => platforms[show.id].name))].sort((a, b) => a.localeCompare(b));

  const entries = [];
  shows.forEach((show) => {
    const platform = platforms[show.id];
    const bySlot = {};
    episodesOf(show).forEach((ep) => {
      const r = releaseOf(ep, platform);
      if (!r || releaseDay(r) !== day) return;
      const slot = r.at ? r.at.getHours() : 'new';
      (bySlot[slot] = bySlot[slot] || []).push({ ep, r });
    });
    Object.keys(bySlot).forEach((key) => {
      const items = bySlot[key].sort((a, b) => a.ep.number - b.ep.number);
      const eps = items.map((x) => x.ep);
      const r = items[0].r;
      entries.push({
        key: show.id + '|' + day + '|' + key,
        channel: platform.name,
        slot: key === 'new' ? 'new' : Number(key),
        at: r.at,
        exact: r.exact,
        tv: r.tv,
        platform,
        title: show.name,
        code: epCode(eps),
        epName: eps.length === 1 ? eps[0].name : eps.length + ' episodes',
        pattern: releasePattern(show),
        show,
      });
    });
  });

  const hours = [...new Set(entries.filter((e) => e.slot !== 'new').map((e) => e.slot))];
  PRIME_TIME.forEach((h) => {
    if (hours.length < 3 && !hours.includes(h)) hours.push(h);
  });
  hours.sort((a, b) => a - b);
  const slots = entries.some((e) => e.slot === 'new') ? ['new', ...hours] : hours;

  // One row per service; a second row for the same service only when two shows share a slot.
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

// ---------- suggestions ----------

// Keep just what search results and suggestions need, so the cache stays small.
function slimShow(show) {
  return {
    id: show.id,
    name: show.name,
    genres: show.genres || [],
    language: show.language,
    network: show.network ? { name: show.network.name } : null,
    webChannel: show.webChannel ? { name: show.webChannel.name } : null,
    premiered: show.premiered,
    status: show.status,
    image: show.image ? { medium: show.image.medium } : null,
    rating: show.rating && show.rating.average ? show.rating.average : 0,
    externals: show.externals ? { imdb: show.externals.imdb, thetvdb: show.externals.thetvdb } : null,
  };
}

// Everything with a new episode in the coming week (streaming plus US TV)
// is the pool that "Suggested for you" and "More like this" pick from.
async function loadPool() {
  const cached = readJSON(POOL_KEY, null);
  if (cached && Date.now() - cached.at < POOL_MS) {
    state.pool = cached.shows;
    return;
  }
  if (state.poolLoading) return;
  state.poolLoading = true;
  const paths = [];
  for (let i = 0; i < 7; i++) {
    const date = ymd(addDays(new Date(), i));
    paths.push('/schedule/web?date=' + date, '/schedule?country=US&date=' + date);
  }
  const byId = {};
  for (let i = 0; i < paths.length; i += 4) {
    const loaded = await Promise.allSettled(paths.slice(i, i + 4).map(getJSON));
    loaded.forEach((r) => {
      if (r.status !== 'fulfilled') return;
      r.value.forEach((ep) => {
        const show = ep.show || (ep._embedded && ep._embedded.show);
        if (show && show.language === 'English') byId[show.id] = slimShow(show);
      });
    });
  }
  state.pool = Object.values(byId);
  state.poolLoading = false;
  if (state.pool.length) writeJSON(POOL_KEY, { at: Date.now(), shows: state.pool });
  render();
}

// Shared genres count most, then the same service, then the show's rating.
function rankLike(genreCounts, channels, exclude, limit) {
  return (state.pool || [])
    .filter((show) => !exclude.has(show.id))
    .map((show) => {
      const overlap = show.genres.reduce((n, g) => n + (genreCounts[g] || 0), 0);
      const score = overlap * 3 + (channels.has(channelOf(show)) ? 1 : 0) + show.rating / 10;
      return { show, overlap, score };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.show);
}

function suggestedForYou() {
  const tracked = myShows();
  const genreCounts = {};
  const channels = new Set();
  tracked.forEach((s) => {
    const show = state.details[s.id];
    if (!show) return;
    (show.genres || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; });
    channels.add(channelOf(show));
  });
  return rankLike(genreCounts, channels, new Set(tracked.map((s) => s.id)), 8);
}

function moreLike(show, exclude) {
  const genreCounts = {};
  (show.genres || []).forEach((g) => { genreCounts[g] = 1; });
  return rankLike(genreCounts, new Set([channelOf(show)]), exclude, 6);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

// For a search with no results: titles this week that are a typo or two away.
function didYouMean(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return (state.pool || [])
    .map((show) => {
      const nameWords = show.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const cost = words.reduce((sum, w) => {
        // Compare against the start of each title word, allowing a letter missed or added.
        const best = Math.min(...nameWords.flatMap((n) => [-1, 0, 1].map((d) => editDistance(w, n.slice(0, Math.max(w.length + d, 1))))));
        return sum + best;
      }, 0);
      return { show, cost };
    })
    .filter((x) => x.cost <= Math.max(1, Math.floor(q.length / 5)))
    .sort((a, b) => a.cost - b.cost || b.show.rating - a.show.rating)
    .slice(0, 5)
    .map((x) => x.show);
}

// ---------- where to watch ----------

// An add-on whose id names another service (a Prime channel, a Disney+ bundle)
// gives you that service too.
const SERVICES = [
  { id: 'netflix', name: 'Netflix', aliases: ['Netflix'], addons: [] },
  { id: 'hulu', name: 'Hulu', aliases: ['Hulu', 'FX on Hulu'], addons: [{ id: 'live', label: 'Live TV' }] },
  { id: 'max', name: 'Max', aliases: ['Max', 'HBO Max', 'HBO'], addons: [] },
  {
    id: 'prime', name: 'Prime Video', aliases: ['Prime Video', 'Amazon Prime Video', 'Amazon', 'Amazon Freevee'],
    addons: [
      { id: 'max', label: 'Max channel' },
      { id: 'paramount', label: 'Paramount+ channel' },
      { id: 'apple', label: 'Apple TV+ channel' },
      { id: 'peacock', label: 'Peacock channel' },
    ],
  },
  { id: 'disney', name: 'Disney+', aliases: ['Disney+'], addons: [{ id: 'hulu', label: 'Hulu bundle' }, { id: 'max', label: 'Max bundle' }] },
  { id: 'apple', name: 'Apple TV+', aliases: ['Apple TV+', 'Apple TV'], addons: [] },
  { id: 'peacock', name: 'Peacock', aliases: ['Peacock'], addons: [] },
  { id: 'paramount', name: 'Paramount+', aliases: ['Paramount+', 'CBS All Access', 'Showtime'], addons: [] },
];

// Where a TV network's shows usually stream the next day. Approximate: deals change.
const NEXT_DAY = {
  ABC: 'hulu', FOX: 'hulu', FX: 'hulu', FXX: 'hulu',
  NBC: 'peacock', Bravo: 'peacock', 'USA Network': 'peacock',
  CBS: 'paramount', 'Comedy Central': 'paramount', MTV: 'paramount', Nickelodeon: 'paramount',
  'Adult Swim': 'max', 'Cartoon Network': 'max', TLC: 'max', HGTV: 'max', 'Food Network': 'max', Discovery: 'max',
};
const BROADCAST = ['ABC', 'FOX', 'NBC', 'CBS'];

function mySubs() {
  return readJSON(SUBS_KEY, { services: {}, addons: {} });
}

// The label of what gives you a service: your own plan, or an add-on on another one.
function accessTo(serviceId, subs) {
  if (subs.services[serviceId]) return { via: '' };
  for (const svc of SERVICES) {
    if (!subs.services[svc.id]) continue;
    const addon = svc.addons.find((a) => a.id === serviceId && subs.addons[svc.id + ':' + a.id]);
    if (addon) return { via: svc.name + ' ' + addon.label, from: svc.name };
  }
  return null;
}

// ---------- full where-to-watch (personal TMDB key) ----------
// TMDB's free key is for personal use, so it is never in the code: each person
// pastes their own, and it stays in their browser.

function tmdbKey() {
  try {
    return localStorage.getItem(TMDB_KEY) || '';
  } catch (e) {
    return '';
  }
}

const providerLoads = {};

async function tmdb(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch('https://api.themoviedb.org/3' + path + sep + 'api_key=' + encodeURIComponent(key));
  if (!res.ok) throw new Error('TMDB ' + res.status);
  return res.json();
}

// Looks the show up on TMDB by its IMDb or TheTVDB id (from TVmaze), then reads
// its US watch providers, which TMDB gets from JustWatch.
async function fetchProviders(show, key) {
  const ext = show.externals || {};
  let tmdbId = null;
  if (ext.imdb) {
    const found = await tmdb('/find/' + ext.imdb + '?external_source=imdb_id', key);
    if (found.tv_results && found.tv_results.length) tmdbId = found.tv_results[0].id;
  }
  if (!tmdbId && ext.thetvdb) {
    const found = await tmdb('/find/' + ext.thetvdb + '?external_source=tvdb_id', key);
    if (found.tv_results && found.tv_results.length) tmdbId = found.tv_results[0].id;
  }
  if (!tmdbId) return null;
  const data = await tmdb('/tv/' + tmdbId + '/watch/providers', key);
  const us = (data.results && data.results.US) || {};
  const names = (list) => (list || []).map((p) => p.provider_name);
  return {
    stream: [...new Set([...names(us.flatrate), ...names(us.ads), ...names(us.free)])],
    buy: [...new Set([...names(us.buy), ...names(us.rent)])],
  };
}

function providersFor(show) {
  const key = tmdbKey();
  if (!key || !show || !show.externals) return undefined;
  if (show.id in state.providers) return state.providers[show.id];
  const cached = readJSON(PROV_PREFIX + show.id, null);
  if (cached && Date.now() - cached.at < PROV_MS) {
    state.providers[show.id] = cached.data;
    return cached.data;
  }
  if (!providerLoads[show.id]) {
    providerLoads[show.id] = fetchProviders(show, key)
      .then((data) => {
        state.providers[show.id] = data;
        writeJSON(PROV_PREFIX + show.id, { at: Date.now(), data });
      })
      .catch(() => {
        state.providers[show.id] = undefined;
      })
      .finally(() => {
        render();
      });
  }
  return undefined;
}

// Provider names look like "Netflix", "Disney Plus", "Max Amazon Channel".
// Channels bought through Prime map to their own service, which accessTo()
// already counts through the Prime add-on.
const PROVIDER_WORDS = [
  ['netflix', /netflix/],
  ['hulu', /hulu/],
  ['max', /\bmax\b|hbo/],
  ['paramount', /paramount|showtime/],
  ['apple', /apple tv/],
  ['peacock', /peacock/],
  ['disney', /disney/],
  ['prime', /amazon prime video|^prime video/],
];

function serviceForProvider(name) {
  const n = name.toLowerCase();
  const hit = PROVIDER_WORDS.find(([, re]) => re.test(n));
  return hit ? SERVICES.find((s) => s.id === hit[0]) : null;
}

function fullWatchInfo(providers) {
  const subs = mySubs();
  const anySubs = Object.values(subs.services).some(Boolean);
  const services = [];
  providers.stream.forEach((name) => {
    const svc = serviceForProvider(name);
    if (svc && !services.includes(svc)) services.push(svc);
  });
  if (!services.length) {
    const other = providers.stream.slice(0, 3).join(', ');
    if (other) return { note: 'Streams on ' + other, have: anySubs ? false : null, label: '✕ NOT IN YOUR SUBS' };
    if (providers.buy.length) return { note: 'Buy or rent only', have: anySubs ? false : null, label: '$ BUY OR RENT' };
    return { note: 'Not streaming in the US right now', have: null };
  }
  const note = 'Streams on ' + services.map((s) => s.name).join(', ');
  if (!anySubs) return { note, have: null };
  const mine = services.map((svc) => ({ svc, access: accessTo(svc.id, subs) })).find((x) => x.access);
  if (!mine) return { note, have: false, label: '✕ NOT IN YOUR SUBS' };
  const via = mine.access.via ? ' VIA ' + mine.access.via.toUpperCase() : '';
  return { note, have: true, label: '✓ YOU HAVE IT · ' + mine.svc.name.toUpperCase() + via };
}

function watchInfo(show) {
  const providers = providersFor(show);
  if (providers) return fullWatchInfo(providers);
  return homeWatchInfo(show);
}

// Uses the show's home service from TVmaze, not every place it streams.
function homeWatchInfo(show) {
  const channel = channelOf(show);
  let svc = SERVICES.find((s) => s.aliases.includes(channel));
  let note = svc ? 'On ' + svc.name : '';
  if (!svc && NEXT_DAY[channel]) {
    svc = SERVICES.find((s) => s.id === NEXT_DAY[channel]);
    note = 'Airs on ' + channel + ' · streams next day on ' + svc.name;
  }
  if (!svc) return null;
  const subs = mySubs();
  if (!Object.values(subs.services).some(Boolean)) return { note, have: null };
  let access = accessTo(svc.id, subs);
  if (!access && BROADCAST.includes(channel) && accessTo('hulu', subs) && subs.addons['hulu:live']) {
    access = { via: 'Hulu Live TV' };
  }
  return {
    note,
    have: !!access,
    label: access ? '✓ YOU HAVE IT' + (access.via ? ' · VIA ' + access.via.toUpperCase() : '') : '✕ NOT IN YOUR SUBS',
  };
}

function watchHtml(show) {
  const info = show ? watchInfo(show) : null;
  if (!info) return '';
  const badge = info.have === null ? '' : `<span class="watch ${info.have ? 'yes' : 'no'}">${esc(info.label)}</span>`;
  return badge + `<span class="watch-note">${esc(info.note)}</span>`;
}

function saveSubs(subs) {
  writeJSON(SUBS_KEY, subs);
}

// ---------- release times ----------

// Usual time new episodes appear on each service, in US Eastern. TVmaze rarely
// has a time for streaming drops, so these fill the gap and show as "~3:00 AM".
const DROP_ET = {
  netflix: [3, 0], hulu: [3, 0], max: [3, 0], disney: [3, 0],
  peacock: [3, 0], paramount: [3, 0], apple: [0, 0], prime: [0, 0],
};

// The streaming service a show's guide row belongs to: one you have if TMDB lists
// several, else its home service, else where its TV network streams next day.
function platformFor(show) {
  const channel = channelOf(show);
  const home = SERVICES.find((s) => s.aliases.includes(channel)) || null;
  const nextDay = !home && !!show.network;
  let svc = null;
  const providers = providersFor(show);
  if (providers && providers.stream.length) {
    const mapped = [...new Set(providers.stream.map(serviceForProvider).filter(Boolean))];
    const subs = mySubs();
    svc = mapped.find((m) => accessTo(m.id, subs)) || (home && mapped.includes(home) ? home : mapped[0]) || null;
  }
  if (!svc) svc = home || (NEXT_DAY[channel] ? SERVICES.find((s) => s.id === NEXT_DAY[channel]) : null);
  if (!svc) return { name: channel, svc: null, nextDay: false, channel };
  return { name: svc.name, svc, nextDay: nextDay && svc !== home, channel };
}

// When an episode goes live on its guide service. TV network shows land on their
// streaming service the next day; timed streaming episodes keep TVmaze's time.
function releaseOf(ep, platform) {
  if (!ep.airdate) return null;
  const timed = !!(ep.airtime && ep.airstamp);
  const drop = platform.svc ? DROP_ET[platform.svc.id] || [3, 0] : null;
  if (platform.nextDay && drop) {
    const next = ymd(addDays(parseYmd(ep.airdate), 1));
    return { at: etDate(next, drop[0], drop[1]), exact: false, tv: timed ? new Date(ep.airstamp) : null };
  }
  if (timed) return { at: new Date(ep.airstamp), exact: true, tv: null };
  if (drop) return { at: etDate(ep.airdate, drop[0], drop[1]), exact: false, tv: null };
  return { at: null, day: ep.airdate, exact: false, tv: null };
}

function releaseDay(r) {
  return r.at ? ymd(r.at) : r.day;
}

// Every release of the shows you follow, for the date bar dots and the calendar.
function allReleases() {
  const out = [];
  myShows().forEach((s) => {
    const show = state.details[s.id];
    if (!show) return;
    const platform = platformFor(show);
    episodesOf(show).forEach((ep) => {
      const r = releaseOf(ep, platform);
      if (r) out.push({ day: releaseDay(r), r, ep, show, platform });
    });
  });
  return out;
}

function whenText(e) {
  const d = e.at || parseYmd(state.day);
  const day = DAY_NAMES[d.getDay()] + ', ' + shortDate(d);
  return e.at ? day + ' · ' + (e.exact ? '' : '~') + timeLabel(e.at) : day;
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

  const today = new Date();
  const todayKey = ymd(today);
  const selectedDate = parseYmd(state.day);
  const releaseDays = new Set(allReleases().map((x) => x.day));
  // A swipeable strip from two weeks back to a year ahead, stretched to reach any day picked in the calendar.
  let first = addDays(today, -14);
  let last = addDays(today, 365);
  if (selectedDate < first) first = addDays(selectedDate, -14);
  if (selectedDate > last) last = addDays(selectedDate, 30);
  const dayButtons = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    const key = ymd(d);
    const cls = 'day' + (key === todayKey ? ' today' : '');
    const top = d.getDate() === 1 ? MONTHS[d.getMonth()] : DAY_NAMES[d.getDay()];
    const dot = releaseDays.has(key) ? '<span class="dot" aria-hidden="true"></span>' : '';
    dayButtons.push(`<button type="button" class="${cls}" aria-pressed="${key === state.day}" data-action="day" data-day="${key}" aria-label="${LONG_DAYS[d.getDay()]} ${shortDate(d)}${dot ? ', new episodes' : ''}">
      <span class="d-short">${top}</span><span class="d-num">${d.getDate()}</span>${dot}</button>`);
  }

  const { slots, rows, entries } = guideFor(state.day);
  let picked = entries.find((e) => e.key === state.picked) || entries[0] || null;

  const head = `<div class="g-row g-head"><div class="g-chan">CHANNEL</div>${slots
    .map((s) => `<div class="g-slot">${slotLabel(s)}</div>`).join('')}</div>`;

  const body = rows.map((row) => {
    const cells = slots.map((slot) => {
      const e = row.cells[slot];
      if (!e) return '<div class="cell-empty">Nothing new</div>';
      const on = picked && picked.key === e.key;
      const tm = e.at ? `<span class="tm">${e.exact ? '' : '~'}${timeLabel(e.at)}</span>` : '';
      return `<button type="button" class="cell" aria-pressed="${on}" data-action="pick" data-key="${esc(e.key)}">
        <span class="t">${esc(e.title)}</span><span class="e">${esc(e.code)}</span>${tm}</button>`;
    }).join('');
    return `<div class="g-row"><div class="g-chan"><span class="num">${row.num}</span><span class="name">${esc(row.channel.toUpperCase())}</span></div>${cells}</div>`;
  }).join('');

  const dayDate = parseYmd(state.day);
  const selected = picked
    ? `<section class="selected" aria-label="Selected show">
        <span class="when">NEW ON ${esc(picked.channel.toUpperCase())}</span>
        <span class="title">${esc(picked.title)}</span>
        <span class="golive">Goes live ${esc(whenText(picked))}</span>
        ${picked.at && !picked.exact ? `<span class="watch-note">Usual release time for ${esc(picked.channel)}, shown in your time zone</span>` : ''}
        ${picked.tv ? `<span class="watch-note">Airs on ${esc(picked.platform.channel)} ${esc(DAY_NAMES[picked.tv.getDay()] + ' ' + timeLabel(picked.tv))}, then streams the next day</span>` : ''}
        <span class="ep">${esc(picked.code)}${picked.epName ? ' · ' + esc(picked.epName) : ''}</span>
        ${picked.pattern ? `<span class="pattern">${esc(picked.pattern)}</span>` : ''}
        ${watchHtml(picked.show)}
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
          <div class="shelf-card"><span class="t">${esc(s.name)}</span><span class="s">${esc(s.season)}</span>${s.pattern ? `<span class="p">${esc(s.pattern)}</span>` : ''}
          <span class="d${s.tba ? ' tba' : ''}">${esc(s.when)}</span></div>`).join('')}</div>
      </section>`
    : '';

  const status = state.loading
    ? '<p class="hint section">Tuning in…</p>'
    : state.loadError
      ? '<p class="hint section error">Some shows couldn\'t load. Check your connection and reopen the app.</p>'
      : '';

  return `
    <nav class="strip" id="strip" aria-label="Day">${dayButtons.join('')}</nav>
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

// ---------- backup ----------

// Your shows and subscriptions as one copyable code, so a reinstall doesn't lose them.
// The TMDB key is left out on purpose: it stays only on the device it was typed into.
function backupCode() {
  const data = { v: 1, shows: myShows(), subs: mySubs() };
  return 'LL1-' + btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

function readBackup(code) {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!clean.startsWith('LL1-')) return null;
  try {
    const data = JSON.parse(decodeURIComponent(escape(atob(clean.slice(4)))));
    if (!Array.isArray(data.shows)) return null;
    const shows = data.shows.filter((x) => x && Number.isInteger(x.id) && typeof x.name === 'string')
      .map((x) => ({ id: x.id, name: x.name, channel: typeof x.channel === 'string' ? x.channel : '' }));
    const subs = data.subs && typeof data.subs.services === 'object' && typeof data.subs.addons === 'object' ? data.subs : null;
    return { shows, subs };
  } catch (e) {
    return null;
  }
}

function restoreBackup(code) {
  const data = readBackup(code);
  if (!data) {
    state.backupMsg = { error: true, text: "That code didn't work. Copy the whole thing, starting with LL1-." };
    render();
    return;
  }
  const list = myShows();
  const have = new Set(list.map((x) => x.id));
  const added = data.shows.filter((x) => !have.has(x.id));
  saveMyShows(list.concat(added));
  if (data.subs) saveSubs(data.subs);
  state.backupMsg = { error: false, text: 'Restored ' + added.length + (added.length === 1 ? ' show' : ' shows') + (data.subs ? ' and your subscriptions.' : '.') };
  state.restoreOpen = false;
  render();
  refreshAll();
}

async function copyBackup() {
  state.backupShown = backupCode();
  let copied = false;
  try {
    await navigator.clipboard.writeText(state.backupShown);
    copied = true;
  } catch (e) { /* the code is shown below to copy by hand */ }
  state.backupMsg = { error: false, text: copied ? 'Backup code copied. Paste it into Notes or a message to yourself.' : 'Press and hold the code below to copy it, then save it in Notes.' };
  render();
}

function renderBackup(hasShows) {
  const msg = state.backupMsg ? `<p class="hint${state.backupMsg.error ? ' error' : ''}">${esc(state.backupMsg.text)}</p>` : '';
  const shown = state.backupShown ? `<textarea class="code-box" readonly aria-label="Backup code">${esc(state.backupShown)}</textarea>` : '';
  const restore = state.restoreOpen ? `<form class="list" data-action="restore">
      <label class="cap" for="restore-code">PASTE YOUR BACKUP CODE</label>
      <textarea id="restore-code" name="code" class="code-box" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="LL1-..."></textarea>
      <button type="submit" class="btn" style="align-self: flex-start">RESTORE</button>
    </form>` : '';
  return `<section class="section" aria-label="Backup">
    <div class="section-title">BACKUP</div>
    <p class="hint">Save a code with your shows and subscriptions, so you can put them back if you reinstall the app or switch phones.</p>
    <div class="row-btns">
      ${hasShows ? '<button type="button" class="btn" data-action="backup-copy">COPY BACKUP CODE</button>' : ''}
      <button type="button" class="btn ghost" data-action="restore-open">RESTORE</button>
    </div>
    ${msg}${shown}${restore}
  </section>`;
}

function renderShows() {
  const list = myShows();
  if (!list.length) {
    return `
      <div class="empty">
        <div class="big">NO SHOWS YET</div>
        <p class="hint">Add the shows you follow and we'll keep track of when new episodes drop.</p>
        <button class="btn" type="button" data-action="tab" data-tab="search">FIND A SHOW</button>
      </div>
      ${renderBackup(false)}`;
  }
  const items = list.map((s) => {
    const show = state.details[s.id];
    return `<div class="item">
      <div class="info">
        <span class="t">${esc(s.name)}</span>
        <span class="s">${esc(s.channel)}</span>
        <span class="n">${esc(showStatus(show))}</span>
        ${watchHtml(show)}
        ${show && releasePattern(show) ? `<span class="s pattern">${esc(releasePattern(show))}</span>` : ''}
      </div>
      <button type="button" class="btn ghost" data-action="remove" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">REMOVE</button>
    </div>`;
  }).join('');
  return `<section class="section"><div class="section-title">MY SHOWS</div><div class="list">${items}</div>
    </section>
    ${renderBackup(true)}
    <div class="section"><p class="hint">Show data from <a href="https://www.tvmaze.com" style="color: var(--yellow)">TVmaze</a>.</p></div>`;
}

function showItem(show, tracked) {
  const added = tracked.has(show.id);
  const year = show.premiered ? show.premiered.slice(0, 4) : '';
  const img = show.image && show.image.medium
    ? `<img src="${esc(show.image.medium)}" alt="" loading="lazy">`
    : '<div class="poster" aria-hidden="true"></div>';
  const genres = (show.genres || []).slice(0, 2).join(', ');
  return `<div class="item${added ? ' in-list' : ''}">
    ${img}
    <div class="info">
      <span class="t">${esc(show.name)}</span>
      <span class="s">${esc(channelOf(show))}${year ? ' · ' + year : ''}${show.status ? ' · ' + esc(show.status) : ''}</span>
      ${genres ? `<span class="s">${esc(genres)}</span>` : ''}
      ${watchHtml(show)}
    </div>
    <button type="button" class="btn${added ? ' added' : ''}" data-action="add" data-id="${show.id}" ${added ? 'disabled' : ''}>${added ? '✓ IN MY SHOWS' : '+ ADD'}</button>
  </div>`;
}

function showList(title, shows, tracked) {
  if (!shows.length) return '';
  return `<div class="section-title" style="margin-top: 12px">${esc(title)}</div>
    <div class="list">${shows.map((show) => showItem(show, tracked)).join('')}</div>`;
}

function renderSuggested(tracked) {
  if (!myShows().length) return '';
  if (!state.pool) return '<p class="hint">Finding shows you might like…</p>';
  const picks = suggestedForYou();
  if (!picks.length) return '';
  return showList('SUGGESTED FOR YOU', picks, tracked) +
    '<p class="hint">Based on the shows you follow, with new episodes this week.</p>';
}

function renderSearch() {
  const tracked = new Set(myShows().map((s) => s.id));
  let results = '';
  if (!state.query.trim()) {
    results = renderSuggested(tracked);
  } else if (state.searching) {
    results = '<p class="hint">Searching…</p>';
  } else if (state.searchError) {
    results = '<p class="hint error">Search isn\'t working right now. Check your connection and try again.</p>';
  } else if (state.results && !state.results.length) {
    const guesses = didYouMean(state.query);
    results = guesses.length
      ? showList('DID YOU MEAN', guesses, tracked)
      : '<p class="hint">No shows found. Try a different spelling.</p>';
  } else if (state.results) {
    const shows = state.results.map((r) => r.show);
    const exclude = new Set([...tracked, ...shows.map((show) => show.id)]);
    results = '<div class="list">' + shows.map((show) => showItem(show, tracked)).join('') + '</div>' +
      showList('MORE LIKE ' + shows[0].name.toUpperCase(), moreLike(shows[0], exclude), tracked);
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

function renderTmdbSetup() {
  const key = tmdbKey();
  if (key) {
    return `<div class="section-title" style="margin-top: 12px">FULL WHERE-TO-WATCH: ON</div>
      <p class="hint">Using your personal TMDB key, saved only on this device. Streaming data from JustWatch via TMDB.</p>
      <button type="button" class="btn ghost" data-action="tmdb-remove" style="align-self: flex-start">REMOVE KEY</button>`;
  }
  return `<div class="section-title" style="margin-top: 12px">FULL WHERE-TO-WATCH</div>
    <p class="hint">Right now "where to watch" uses each show's home service. Paste a personal TMDB API key to see every service a show streams on. It's saved only on this device.</p>
    <form class="list" data-action="tmdb-save">
      <label class="cap" for="tmdb-key">TMDB API KEY</label>
      <div class="search-box"><input id="tmdb-key" name="key" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your key"></div>
      <button type="submit" class="btn" style="align-self: flex-start">SAVE KEY</button>
      ${state.tmdbError ? '<p class="hint error">That key didn\'t work. Check you copied the API Key (the shorter one).</p>' : ''}
    </form>`;
}

function renderSubs() {
  const subs = mySubs();
  const count = SERVICES.filter((s) => accessTo(s.id, subs)).length;
  const cards = SERVICES.map((svc) => {
    const on = !!subs.services[svc.id];
    // A bundle or channel on another plan counts as having this service.
    const access = accessTo(svc.id, subs);
    const covered = !on && !!access;
    const addons = (on || covered) && svc.addons.length
      ? `<div class="addons"><span class="cap">ADD-ONS</span>${svc.addons.map((a) => {
        const key = svc.id + ':' + a.id;
        const aOn = !!subs.addons[key];
        return `<button type="button" class="chip" aria-pressed="${aOn}" data-action="addon" data-key="${key}">${aOn ? '✓' : '+'} ${esc(a.label)}</button>`;
      }).join('')}</div>`
      : '';
    return `<div class="sub${on || covered ? ' on' : ''}">
      <button type="button" class="sub-toggle" aria-pressed="${on}" data-action="sub" data-id="${svc.id}">
        <span class="sub-name">${esc(svc.name.toUpperCase())}</span>
        <span class="sub-pill">${on ? 'I HAVE IT' : covered ? 'VIA ' + esc(access.from.toUpperCase()) : 'ADD'}</span>
      </button>
      ${addons}
    </div>`;
  }).join('');
  return `<section class="section">
    <div class="section-title">MY SUBSCRIPTIONS</div>
    <p class="hint">Tap the services you pay for, then any add-ons. Search and your guide will show what you can already watch.</p>
    <div class="section-title" style="font-size: 20px">${count} OF ${SERVICES.length} SERVICES</div>
    <div class="list">${cards}</div>
    ${renderTmdbSetup()}
  </section>`;
}

function renderCalendar() {
  const month = state.calMonth;
  const y = month.getFullYear();
  const m = month.getMonth();
  const todayKey = ymd(new Date());
  const releases = allReleases();
  const releaseDays = new Set(releases.map((x) => x.day));
  const firstDow = new Date(y, m, 1).getDay();
  const daysIn = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push('<span class="cal-blank"></span>');
  for (let d = 1; d <= daysIn; d++) {
    const key = ymd(new Date(y, m, d));
    const cls = 'cal-day' + (key === todayKey ? ' today' : '');
    const dot = releaseDays.has(key) ? '<span class="dot" aria-hidden="true"></span>' : '';
    cells.push(`<button type="button" class="${cls}" aria-pressed="${key === state.day}" data-action="cal-day" data-day="${key}">${d}${dot}</button>`);
  }
  const thisYear = new Date().getFullYear();
  const monthOpts = MONTHS.map((name, i) => `<option value="${i}"${i === m ? ' selected' : ''}>${name}</option>`).join('');
  const years = [];
  for (let yr = Math.min(thisYear - 1, y); yr <= Math.max(thisYear + 5, y); yr++) years.push(yr);
  const yearOpts = years.map((yr) => `<option value="${yr}"${yr === y ? ' selected' : ''}>${yr}</option>`).join('');

  const prefix = y + '-' + pad(m + 1) + '-';
  const inMonth = releases.filter((x) => x.day.startsWith(prefix)).sort((a, b) => a.day.localeCompare(b.day));
  const seen = new Set();
  const list = inMonth.filter((x) => {
    const k = x.show.id + x.day;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map((x) => {
    const d = parseYmd(x.day);
    return `<button type="button" class="cal-item" data-action="cal-day" data-day="${x.day}">
      <span class="n">${DAY_NAMES[d.getDay()]} ${d.getDate()}</span>
      <span class="t">${esc(x.show.name)}</span>
      <span class="s">${esc(x.platform.name)} · S${x.ep.season} E${x.ep.number}</span>
    </button>`;
  }).join('');

  return `<div class="cal-backdrop" data-action="cal-close"></div>
    <div class="cal" role="dialog" aria-modal="true" aria-label="Pick a date">
      <div class="cal-head">
        <button type="button" class="week-arrow" data-action="cal-move" data-dir="-1" aria-label="Previous month">‹</button>
        <label class="sr" for="cal-month">Month</label>
        <select id="cal-month" class="cal-select">${monthOpts}</select>
        <label class="sr" for="cal-year">Year</label>
        <select id="cal-year" class="cal-select">${yearOpts}</select>
        <button type="button" class="week-arrow" data-action="cal-move" data-dir="1" aria-label="Next month">›</button>
      </div>
      <div class="cal-grid">${DAY_NAMES.map((n) => `<span class="cal-dow">${n[0]}</span>`).join('')}${cells.join('')}</div>
      <div class="section-title" style="font-size: 20px">${inMonth.length ? 'YOUR RELEASES IN ' + MONTHS[m] : 'NO RELEASES ANNOUNCED IN ' + MONTHS[m] + ' YET'}</div>
      <div class="cal-list">${list}</div>
      <div class="cal-actions">
        <button type="button" class="btn ghost" data-action="cal-day" data-day="${todayKey}">TODAY</button>
        <button type="button" class="btn" data-action="cal-close">CLOSE</button>
      </div>
    </div>`;
}

function render() {
  const view = document.getElementById('view');
  const hadFocus = document.activeElement && document.activeElement.id === 'q';
  const caret = hadFocus ? document.activeElement.selectionStart : null;

  const views = { guide: renderGuide, shows: renderShows, search: renderSearch, subs: renderSubs };
  view.innerHTML = views[state.tab]();

  document.querySelectorAll('.tabs button').forEach((b) => {
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });

  const d = parseYmd(state.day);
  const topDate = document.getElementById('top-date');
  topDate.hidden = state.tab !== 'guide';
  topDate.querySelector('span').textContent = shortDate(d);
  topDate.setAttribute('aria-label', 'Pick a date, showing ' + LONG_DAYS[d.getDay()] + ' ' + shortDate(d));

  document.getElementById('overlay').innerHTML = state.calOpen ? renderCalendar() : '';

  // Keep the picked day in the middle of the date bar.
  const strip = document.getElementById('strip');
  const sel = strip && strip.querySelector('[aria-pressed="true"]');
  if (sel) strip.scrollLeft = sel.offsetLeft - strip.clientWidth / 2 + sel.offsetWidth / 2;

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

// TVmaze only matches whole words, so while the last word is half typed
// ("abbott elem"), search the finished words and keep titles that match every prefix.
async function searchShows(q) {
  const results = await getJSON('/search/shows?q=' + encodeURIComponent(q));
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (results.length || words.length < 2) return results;
  const broader = await getJSON('/search/shows?q=' + encodeURIComponent(words.slice(0, -1).join(' ')));
  return broader.filter(({ show }) => {
    const nameWords = show.name.toLowerCase().split(/[^a-z0-9]+/);
    return words.every((w) => nameWords.some((n) => n.startsWith(w)));
  });
}

async function runSearch(q) {
  state.query = q;
  if (!q.trim()) {
    state.results = null;
    render();
    return;
  }
  if (!state.pool) loadPool();
  const seq = ++searchSeq;
  state.searching = true;
  state.searchError = false;
  render();
  try {
    const results = await searchShows(q.trim());
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
  const found = (state.results || []).map((r) => r.show).concat(state.pool || []).find((show) => show.id === id);
  if (!found) return;
  const list = myShows();
  if (list.some((s) => s.id === id)) return;
  list.push({ id, name: found.name, channel: channelOf(found) });
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
    if (state.tab === 'search' && !state.pool) loadPool();
  } else if (action === 'day') {
    state.day = el.dataset.day;
    state.picked = null;
    render();
  } else if (action === 'cal-open') {
    const d = parseYmd(state.day);
    state.calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    state.calOpen = true;
    render();
  } else if (action === 'cal-move') {
    const m = state.calMonth;
    state.calMonth = new Date(m.getFullYear(), m.getMonth() + Number(el.dataset.dir), 1);
    render();
  } else if (action === 'cal-day') {
    state.day = el.dataset.day;
    state.picked = null;
    state.calOpen = false;
    state.tab = 'guide';
    render();
  } else if (action === 'cal-close') {
    state.calOpen = false;
    render();
  } else if (action === 'pick') {
    state.picked = el.dataset.key;
    render();
  } else if (action === 'add') {
    addShow(Number(el.dataset.id));
  } else if (action === 'sub') {
    const subs = mySubs();
    subs.services[el.dataset.id] = !subs.services[el.dataset.id];
    saveSubs(subs);
    render();
  } else if (action === 'addon') {
    const subs = mySubs();
    subs.addons[el.dataset.key] = !subs.addons[el.dataset.key];
    saveSubs(subs);
    render();
  } else if (action === 'tmdb-remove') {
    try { localStorage.removeItem(TMDB_KEY); } catch (e) { /* ignore */ }
    state.providers = {};
    render();
  } else if (action === 'remove') {
    removeShow(Number(el.dataset.id));
  } else if (action === 'backup-copy') {
    copyBackup();
  } else if (action === 'restore-open') {
    state.restoreOpen = !state.restoreOpen;
    state.backupMsg = null;
    render();
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'cal-month' || ev.target.id === 'cal-year') {
    const month = Number(document.getElementById('cal-month').value);
    const year = Number(document.getElementById('cal-year').value);
    state.calMonth = new Date(year, month, 1);
    render();
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.calOpen) {
    state.calOpen = false;
    render();
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'q') return;
  clearTimeout(searchTimer);
  const q = ev.target.value;
  state.query = q;
  searchTimer = setTimeout(() => runSearch(q), 350);
});

async function saveTmdbKey(key) {
  key = key.trim();
  if (!key) return;
  try {
    await tmdb('/configuration', key);
  } catch (e) {
    state.tmdbError = true;
    render();
    return;
  }
  state.tmdbError = false;
  try { localStorage.setItem(TMDB_KEY, key); } catch (e) { /* ignore */ }
  state.providers = {};
  render();
}

document.addEventListener('submit', (ev) => {
  if (ev.target.dataset.action === 'tmdb-save') {
    ev.preventDefault();
    saveTmdbKey(ev.target.key.value);
    return;
  }
  if (ev.target.dataset.action === 'restore') {
    ev.preventDefault();
    restoreBackup(ev.target.code.value);
    return;
  }
  if (ev.target.dataset.action !== 'search') return;
  ev.preventDefault();
  clearTimeout(searchTimer);
  runSearch(ev.target.q.value);
});

render();
refreshAll();

// iPhone Safari ignores user-scalable=no in the browser, so block pinch zoom here too.
document.addEventListener('gesturestart', (ev) => ev.preventDefault());

if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
