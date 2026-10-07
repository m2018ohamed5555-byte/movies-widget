import { mkdir, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_KEY;
const REGIONS = (process.env.REGIONS || 'US').split(',');
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const TOP = 10, MIN_POP = 5;

const PROV = {
  all: null, netflix: '8', disney: '337', prime: '9|119',
  max: '1899|384', apple: '350', hulu: '15',
  paramount: '531', peacock: '386|387',
};
const ANT = { pop: .6, trend: .2, vote: .1, prox: .1 };
const TRN = { pop: .3, trend: .7, vote: 0, prox: 0 };
const REL = { pop: .7, trend: .3, vote: 0, prox: 0 };

const DAY = 864e5, now = Date.now();
const dOff = n => new Date(now + n * DAY).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(path, params = {}) {
  const u = new URL(API + path);
  u.searchParams.set('api_key', KEY);
  u.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let i = 0; i < 4; i++) {
    const r = await fetch(u);
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status < 500) throw new Error(`${r.status} ${path}`);
    await sleep(1000 * (i + 1));
  }
  throw new Error('failed ' + path);
}

async function pages(path, params, n) {
  const out = [];
  for (let p = 1; p <= n; p++) {
    const d = await get(path, { ...params, page: p });
    out.push(...(d.results || []));
    if (p >= d.total_pages) break;
  }
  return out;
}

const lim = async (arr, n, fn) => {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < arr.length) { const k = i++; out[k] = await fn(arr[k]); }
  }));
  return out;
};

// ---------- ranking ----------
const norm = (arr, f) => {
  const v = arr.map(x => Math.log1p(f(x)));
  const lo = Math.min(...v), hi = Math.max(...v);
  return v.map(x => (hi === lo ? 0.5 : (x - lo) / (hi - lo)));
};
const prox = date => {
  const d = (Date.parse(date) - now) / DAY;
  return d <= 14 ? 1 : d <= 30 ? 0.6 : d <= 60 ? 0.3 : 0;
};
const vote = m => ((m.vote_average || 0) / 10) * Math.min(1, (m.vote_count || 0) / 200);
const ok = m => m.poster_path && m.overview && !m.adult && m.popularity >= MIN_POP;

function pick(list, tr, W, used, n) {
  const pool = [...new Map(
    list.filter(m => ok(m) && !used.has(m.id)).map(m => [m.id, m])
  ).values()];
  const p = norm(pool, m => m.popularity);
  return pool.map((m, i) => {
    const t = tr.get(m.id) || 0;
    const s = W.pop * p[i] + W.trend * t + W.vote * vote(m) + W.prox * prox(m.release_date);
    return { id: m.id, score: +s.toFixed(4), hot: t > 0 };
  }).sort((a, b) => b.score - a.score).slice(0, n);
}

// ---------- details ----------
const shape = d => {
  const logo = (d.images?.logos || [])
    .filter(l => (l.iso_639_1 === 'en' || !l.iso_639_1) && l.file_path.endsWith('.png'))
    .sort((a, b) => b.vote_average - a.vote_average)[0];
  const tr = (d.videos?.results || []).find(v => v.site === 'YouTube' && v.type === 'Trailer');
  const rt = d.runtime || 0;
  return {
    id: d.id, title: d.title, date: d.release_date,
    rating: +(d.vote_average || 0).toFixed(1),
    overview: d.overview, tagline: d.tagline || null,
    runtime: rt, runtime_text: rt > 0 ? `${Math.floor(rt / 60)}h ${rt % 60}m` : null,
    genres: d.genres.map(g => g.name).join(' • '),
    genres_list: d.genres.map(g => g.name),
    poster: IMG + 'w500' + d.poster_path,
    backdrop: d.backdrop_path ? IMG + 'w780' + d.backdrop_path : null,
    logo: logo ? IMG + 'w500' + logo.file_path : null,
    trailer: tr ? 'https://www.youtube.com/watch?v=' + tr.key : null,
  };
};
const cache = new Map();
const detail = id => {
  if (!cache.has(id)) cache.set(id, get(`/movie/${id}`, {
    append_to_response: 'videos,images', include_image_language: 'en,null',
  }).then(shape));
  return cache.get(id);
};

// ---------- build ----------
const disc = (region, extra) => ({
  region, watch_region: region, include_adult: false, include_video: false,
  sort_by: 'popularity.desc', ...extra,
});

async function buildRegion(region) {
  const trend = await pages('/trending/movie/day', {}, 3);
  const tr = new Map(trend.map((m, i) => [m.id, 1 - i / trend.length]));
  const files = {};

  for (const [slug, ids] of Object.entries(PROV)) {
    const pv = ids ? { with_watch_providers: ids, with_watch_monetization_types: 'flatrate' } : {};
    const rt = ids ? '2|3|4|6' : '2|3';
    // a..b = تاريخ الإصدار في المنطقة | pa..b = التاريخ الأصلي (يمنع إعادات العرض)
    const win = (a, b, pa = a) => ({
      'release_date.gte': dOff(a), 'release_date.lte': dOff(b),
      'primary_release_date.gte': dOff(pa), 'primary_release_date.lte': dOff(b),
      with_release_type: rt,
    });

    const [ant, rel, base] = await Promise.all([
      pages('/discover/movie', disc(region, { ...pv, ...win(1, ids ? 180 : 90) }), 3),
      pages('/discover/movie', disc(region, { ...pv, ...win(ids ? -30 : -14, 0, ids ? -120 : -60) }), 2),
      ids ? pages('/discover/movie', disc(region, pv), 5) : Promise.resolve([]),
    ]);

    const have = new Set(base.map(m => m.id));
    const used = new Set();
    const take = (list, W, n = TOP) => {
      const r = pick(list, tr, W, used, n);
      r.forEach(m => used.add(m.id));
      return r;
    };

    const sec = {};
    sec.anticipated = take(ant, ANT);
    sec.released = take(rel, REL);
    let t = take(ids ? trend.filter(m => have.has(m.id)) : trend, TRN);
    if (ids && t.length < TOP) t = [...t, ...take(base, TRN, TOP - t.length)];
    sec.trending = t;

    for (const k of Object.keys(sec)) {
      sec[k] = (await lim(sec[k], 6, async m => {
        const d = await detail(m.id).catch(() => null);
        return d && { ...d, score: m.score, hot: m.hot };
      })).filter(Boolean);
    }
    files[slug] = {
      meta: {
        region, provider: slug, updated: new Date().toISOString(),
        n: { a: sec.anticipated.length, t: sec.trending.length, r: sec.released.length },
      },
      ...sec,
    };
    console.log(region, slug, files[slug].meta.n);
  }
  return files;
}

for (const region of REGIONS) {
  const files = await buildRegion(region);
  if (!files.all.anticipated.length) throw new Error('empty all/anticipated');
  await mkdir(`data/${region}`, { recursive: true });
  for (const [slug, data] of Object.entries(files))
    await writeFile(`data/${region}/${slug}.json`, JSON.stringify(data));
  if (region === REGIONS[0])
    await writeFile('movies.json', JSON.stringify({ movies: files.all.anticipated }));
      }
