import { mkdir, writeFile } from 'node:fs/promises';

const KEY = process.env.TMDB_KEY;
const REGIONS = (process.env.REGIONS || 'US').split(',');
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const TOP = 10, MIN_POP = 5, MIN_ANT = 5;

const PROV = {
  all: null, netflix: '8', disney: '337', prime: '9|119',
  max: '1899|384', apple: '350', hulu: '15',
  paramount: '531', peacock: '386|387',
};
// الاستوديوهات المرتبطة بكل خدمة (تقدير). Netflix وApple بياناتهم الحقيقية كفاية
const STUDIO = {
  disney: ['Marvel Studios', 'Lucasfilm Ltd.', 'Pixar', 'Walt Disney Pictures', '20th Century Studios'],
  max: ['Warner Bros. Pictures', 'DC Studios', 'New Line Cinema', 'Legendary Pictures'],
  paramount: ['Paramount Pictures', 'Paramount Animation', 'Nickelodeon Movies'],
  peacock: ['Universal Pictures', 'Illumination', 'DreamWorks Animation', 'Focus Features', 'Blumhouse Productions'],
  prime: ['Amazon MGM Studios', 'Metro-Goldwyn-Mayer'],
  hulu: ['20th Century Studios', 'Searchlight Pictures'],
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

// ---------- studios ----------
const cid = new Map();
async function companies(names) {
  const out = [];
  for (const n of names) {
    if (!cid.has(n)) {
      const d = await get('/search/company', { query: n });
      const r = d.results || [];
      const hit = r.find(c => c.name.toLowerCase() === n.toLowerCase()) || r[0];
      cid.set(n, hit ? hit.id : null);
      console.log('studio', n, '->', hit ? `${hit.id} ${hit.name}` : 'NOT FOUND');
    }
    if (cid.get(n)) out.push(cid.get(n));
  }
  return out.join('|');
}

// ---------- ranking ----------
const norm = (arr, f) => {
  const v = arr.map(x => Math.log1p(f(x)));
  const lo = Math.min(...v), hi = Math.max(...v);
  return v.map(x => (hi === lo ? 0.5 : (x - lo) / (hi - lo)));
};
const prox = date => {
  const d = (Date.parse(date) - now) / DAY;
  if (!(d >= 0)) return 0;
  return d <= 14 ? 1 : d <= 30 ? 0.6 : d <= 60 ? 0.3 : 0;
};
const vote = m => ((m.vote_average || 0) / 10) * Math.min(1, (m.vote_count || 0) / 200);
const ok = m => m.poster_path && m.overview && !m.adult && m.popularity >= MIN_POP;

function pick(list, tr, W, used, n, src = new Set()) {
  const pool = [...new Map(
    list.filter(m => ok(m) && !used.has(m.id)).map(m => [m.id, m])
  ).values()];
  const p = norm(pool, m => m.popularity);
  return pool.map((m, i) => {
    const t = tr.get(m.id) || 0;
    const s = W.pop * p[i] + W.trend * t + W.vote * vote(m) + W.prox * prox(m.release_date);
    return { id: m.id, score: +s.toFixed(4), hot: t > 0, ...(src.has(m.id) ? { src: 'studio' } : {}) };
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

const enrich = async (list, extra = {}) =>
  (await lim(list, 6, async m => {
    const d = await detail(m.id).catch(() => null);
    return d && { ...d, score: m.score, hot: m.hot, ...(m.src ? { src: m.src } : {}), ...extra };
  })).filter(Boolean);

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
    const win = (a, b, pa = a, t = rt) => ({
      'release_date.gte': dOff(a), 'release_date.lte': dOff(b),
      'primary_release_date.gte': dOff(pa), 'primary_release_date.lte': dOff(b),
      with_release_type: t,
    });
    const studio = STUDIO[slug] ? await companies(STUDIO[slug]) : '';

    const [ant, rel, base, stu] = await Promise.all([
      pages('/discover/movie', disc(region, { ...pv, ...win(1, ids ? 180 : 90) }), 3),
      pages('/discover/movie', disc(region, { ...pv, ...win(ids ? -30 : -14, 0, ids ? -120 : -30) }), 2),
      ids ? pages('/discover/movie', disc(region, pv), 5) : Promise.resolve([]),
      studio
        ? pages('/discover/movie', disc(region, { with_companies: studio, ...win(1, 90, 1, '2|3') }), 2)
        : Promise.resolve([]),
    ]);

    const have = new Set(base.map(m => m.id));
    const stuIds = new Set(stu.map(m => m.id));
    const used = new Set();
    const take = (list, W, n = TOP, src) => {
      const r = pick(list, tr, W, used, n, src);
      r.forEach(m => used.add(m.id));
      return r;
    };

    const sec = {};
    sec.anticipated = take([...ant, ...stu], ANT, TOP, stuIds);
    if (ids) {
      sec.trending = take(trend.filter(m => have.has(m.id)), TRN);
      sec.released = take(rel, REL);
      if (sec.trending.length < TOP)
        sec.trending = [...sec.trending, ...take(base, TRN, TOP - sec.trending.length)];
    } else {
      sec.released = take(rel, REL);
      sec.trending = take(trend, TRN);
    }

    for (const k of Object.keys(sec)) sec[k] = await enrich(sec[k]);

    // لسه ناقص -> نكمّل من أشهر أفلام نفس الـprovider
    let fb = 0;
    if (ids && sec.anticipated.length < MIN_ANT) {
      const extra = await enrich(
        take(base, ANT, TOP - sec.anticipated.length), { fb: true }
      );
      fb = extra.length;
      sec.anticipated = [...sec.anticipated, ...extra];
    }

    files[slug] = {
      meta: {
        region, provider: slug, updated: new Date().toISOString(),
        n: { a: sec.anticipated.length, t: sec.trending.length, r: sec.released.length },
        studio: sec.anticipated.filter(m => m.src === 'studio').length,
        fb,
      },
      ...sec,
    };
    console.log(region, slug, files[slug].meta.n, 'studio', files[slug].meta.studio, 'fb', fb);
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
