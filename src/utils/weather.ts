import { requestUrl } from "obsidian";

/**
 * 天气数据源：
 * - cma：中国气象局 weather.cma.cn 的站点数据（国家站覆盖到县区，免密钥；非公开接口，拒绝 curl UA，Obsidian 的 UA 正常）
 * - openmeteo：Open-Meteo 全球格点预报，免密钥；地名解析对中文县名很弱，所以优先让用户选定坐标
 * - qweather：和风天气，需要开发者自己的 API Host + Key（免费额度 5 万次/月）
 */
export type WeatherSource = "cma" | "openmeteo" | "qweather";

export interface WeatherInfo {
  tempC: number;
  feelsC: number;
  text: string;
  icon: string;
  city: string;
  /** 当天最高 / 最低（拿不到时省略）。 */
  high?: number;
  low?: number;
  source: WeatherSource;
  /** 按名称自动匹配到的位置（调用方可以持久化，下次就不用再解析）。 */
  resolved?: WeatherLocation;
}

export interface WeatherLocation {
  /** cma=站号；qweather=LocationID；openmeteo="纬度,经度"。 */
  id: string;
  name: string;
  /** 归属，例如“中国 · 浙江”。 */
  detail: string;
}

export interface WeatherQuery {
  source: WeatherSource;
  /** 城市 / 区县名；可写“浙江 安吉”用前半段限定省份；Open-Meteo 也接受“纬度,经度”。 */
  city: string;
  /** 已选定的位置 id（见 WeatherLocation.id）；留空按 city 自动匹配。 */
  location: string;
  qweatherHost: string;
  qweatherKey: string;
}

type CacheEntry = { expires: number; data?: WeatherInfo };
const cache = new Map<string, CacheEntry>();
const WEATHER_TTL = 30 * 60 * 1000;
const WEATHER_FAIL_TTL = 5 * 60 * 1000;
const CMA_BASE = "https://weather.cma.cn/api";

export function isWeatherSource(value: unknown): value is WeatherSource {
  return value === "cma" || value === "openmeteo" || value === "qweather";
}

function cacheKey(query: WeatherQuery): string {
  const target = query.location.trim() || `name:${query.city.trim()}`;
  if (!query.location.trim() && !query.city.trim()) return "";
  return `${query.source}:${target}:${query.source === "qweather" ? normalizeHost(query.qweatherHost) : ""}`;
}

export async function fetchWeather(query: WeatherQuery): Promise<WeatherInfo | undefined> {
  const key = cacheKey(query);
  if (!key) return undefined;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  try {
    const data = query.source === "qweather" ? await fetchQWeather(query) : query.source === "openmeteo" ? await fetchOpenMeteo(query) : await fetchCma(query);
    cache.set(key, { expires: Date.now() + (data ? WEATHER_TTL : WEATHER_FAIL_TTL), data });
    return data;
  } catch (error) {
    console.error("Home Pages: failed to fetch weather", error);
    cache.set(key, { expires: Date.now() + WEATHER_FAIL_TTL });
    return undefined;
  }
}

/** 设置面板用：按名称列出候选位置，供用户选定。 */
export async function searchWeatherLocations(query: WeatherQuery, text: string): Promise<WeatherLocation[]> {
  const { name, hint } = splitQuery(text);
  if (!name) return [];
  if (query.source === "qweather") return qweatherLookup(query, name, hint);
  if (query.source === "openmeteo") {
    const coords = parseCoords(name);
    if (coords) return [{ id: coordsId(coords), name, detail: "坐标" }];
    return (await openMeteoSearch(name, hint)).map((item) => ({ id: coordsId(item), name: item.name, detail: item.detail }));
  }
  return cmaSearch(name, hint);
}

// ---- 公共小工具 ------------------------------------------------------------------

/** “浙江 安吉” → name=安吉, hint=浙江；单个词则没有 hint。 */
export function splitQuery(text: string): { name: string; hint: string } {
  const parts = text.trim().split(/[\s,，/／·]+/).filter(Boolean);
  if (parts.length === 0) return { name: "", hint: "" };
  return { name: parts[parts.length - 1], hint: parts.slice(0, -1).join("") };
}

/** 去掉“县 / 区 / 市 / 旗”之类后缀用于比对（至少保留两个字，避免把“杭州”切坏）。 */
export function stripSuffix(name: string): string {
  const match = name.trim().match(/^(.{2,}?)(?:自治县|自治州|自治旗|新区|县|区|市|旗)$/u);
  return match ? match[1] : name.trim();
}

export function parseCoords(text: string): { lat: number; lon: number } | null {
  const match = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,，]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function coordsId(coords: { lat: number; lon: number }): string {
  return `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}`;
}

function isDaytime(): boolean {
  const hour = new Date().getHours();
  return hour >= 6 && hour < 18;
}

/** 按天气描述猜图标：各数据源的编码表不一致时兜底。 */
export function iconFromText(text: string, isDay = true): string {
  if (/雷/.test(text)) return "cloud-lightning";
  if (/冰雹|雨夹雪|冻雨/.test(text)) return "cloud-hail";
  if (/雪/.test(text)) return "cloud-snow";
  if (/毛毛雨|小雨/.test(text)) return "cloud-drizzle";
  if (/阵雨/.test(text)) return "cloud-rain-wind";
  if (/雨/.test(text)) return "cloud-rain";
  if (/雾/.test(text)) return "cloud-fog";
  if (/霾/.test(text)) return "haze";
  if (/沙|尘|风/.test(text)) return "wind";
  if (/阴/.test(text)) return "cloud";
  if (/云/.test(text)) return isDay ? "cloud-sun" : "cloud-moon";
  if (/晴/.test(text)) return isDay ? "sun" : "moon";
  return "cloud";
}

function round(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

// ---- 中国气象局 ------------------------------------------------------------------

type CmaCandidate = { id: string; name: string; pinyin: string; country: string };

async function cmaAutocomplete(text: string): Promise<CmaCandidate[]> {
  const response = await requestUrl({ url: `${CMA_BASE}/autocomplete?q=${encodeURIComponent(text)}` });
  const json = response.json as { code?: number; data?: unknown };
  if (json?.code !== 0 || !Array.isArray(json.data)) return [];
  return json.data
    .map((item) => String(item).split("|"))
    .filter((parts) => parts.length >= 2 && parts[0])
    .map(([id, name, pinyin = "", country = ""]) => ({ id, name, pinyin, country }));
}

/** 自动补全是逐字模糊匹配，还夹着外国首都；按“名字完全一致 > 前缀 > 包含 > 拼音”重排，中国站优先。 */
export function rankCmaCandidates(candidates: CmaCandidate[], name: string): CmaCandidate[] {
  const wanted = stripSuffix(name);
  const lower = name.trim().toLowerCase();
  const score = (item: CmaCandidate): number => {
    const bare = stripSuffix(item.name);
    let rank = 9;
    if (item.name === name.trim() || bare === wanted) rank = 0;
    else if (bare.startsWith(wanted)) rank = 1;
    else if (bare.includes(wanted)) rank = 2;
    else if (item.pinyin.toLowerCase() === lower) rank = 3;
    else if (item.pinyin.toLowerCase().startsWith(lower)) rank = 4;
    return rank + (item.country === "中国" ? 0 : 10);
  };
  return candidates
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

async function cmaLocationPath(id: string): Promise<string> {
  try {
    const response = await requestUrl({ url: `${CMA_BASE}/now/${encodeURIComponent(id)}` });
    const json = response.json as { code?: number; data?: { location?: { path?: string } } };
    return json?.code === 0 ? (json.data?.location?.path ?? "") : "";
  } catch {
    return "";
  }
}

function pathDetail(path: string): string {
  // "中国, 浙江, 安吉" → "中国 · 浙江"
  const parts = path.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
  return parts.slice(0, -1).join(" · ");
}

async function cmaSearch(name: string, hint: string): Promise<WeatherLocation[]> {
  const ranked = rankCmaCandidates(await cmaAutocomplete(name), name).slice(0, 8);
  const paths = await Promise.all(ranked.map((item) => cmaLocationPath(item.id)));
  const results = ranked.map((item, index) => ({ id: item.id, name: item.name, detail: pathDetail(paths[index]) || item.country, path: paths[index] }));
  if (!hint) return results;
  return results.sort((a, b) => Number(b.path.includes(hint)) - Number(a.path.includes(hint)));
}

async function fetchCma(query: WeatherQuery): Promise<WeatherInfo | undefined> {
  let id = query.location.trim();
  let resolved: WeatherLocation | undefined;
  if (!id) {
    const { name, hint } = splitQuery(query.city);
    if (!name) return undefined;
    const ranked = rankCmaCandidates(await cmaAutocomplete(name), name).filter((item) => item.country === "中国" || !hint);
    let best = ranked[0];
    if (hint && ranked.length > 1) {
      // 有省份限定时多查几站的归属，挑出对得上的（重名如“朝阳”）。
      const paths = await Promise.all(ranked.slice(0, 5).map((item) => cmaLocationPath(item.id)));
      const index = paths.findIndex((path) => path.includes(hint));
      if (index >= 0) best = ranked[index];
    }
    const matches = best && (stripSuffix(best.name) === stripSuffix(name) || best.pinyin.toLowerCase() === name.toLowerCase());
    if (!best || !matches) return undefined;
    id = best.id;
    resolved = { id: best.id, name: best.name, detail: best.country };
  }
  const response = await requestUrl({ url: `${CMA_BASE}/weather/view?stationid=${encodeURIComponent(id)}` });
  const json = response.json as {
    code?: number;
    data?: {
      location?: { id?: string; name?: string; path?: string };
      now?: { temperature?: number; feelst?: number };
      daily?: Array<{ high?: number; low?: number; dayText?: string; dayCode?: number; nightText?: string; nightCode?: number }>;
    };
  };
  const data = json?.code === 0 ? json.data : undefined;
  const temp = round(data?.now?.temperature);
  if (!data || temp === undefined) return undefined;
  const today = data.daily?.[0];
  const isDay = isDaytime();
  const text = (isDay ? today?.dayText : today?.nightText) || today?.dayText || "";
  const code = isDay ? today?.dayCode : today?.nightCode;
  if (resolved && data.location?.path) resolved.detail = pathDetail(data.location.path) || resolved.detail;
  return {
    tempC: temp,
    feelsC: round(data.now?.feelst) ?? temp,
    text: text || "—",
    icon: cmaIcon(code, text, isDay),
    city: data.location?.name || resolved?.name || query.city,
    high: round(today?.high),
    low: round(today?.low),
    source: "cma",
    resolved
  };
}

/** 中国气象局天气现象编码（weather.cma.cn 使用的 0–33）。 */
export function cmaIcon(code: number | undefined, text: string, isDay: boolean): string {
  switch (code) {
    case 0: return isDay ? "sun" : "moon";
    case 1: return isDay ? "cloud-sun" : "cloud-moon";
    case 2: return "cloud";
    case 3: return "cloud-rain-wind";
    case 4: case 5: return "cloud-lightning";
    case 6: case 19: return "cloud-hail";
    case 7: return "cloud-drizzle";
    case 8: case 9: case 10: case 11: case 12: case 21: case 22: case 23: case 24: case 25: return "cloud-rain";
    case 13: case 14: case 15: case 16: case 17: case 26: case 27: case 28: return "cloud-snow";
    case 18: return "cloud-fog";
    case 20: case 29: case 30: case 31: return "wind";
    case 32: return "haze";
    default: return iconFromText(text, isDay);
  }
}

// ---- Open-Meteo ------------------------------------------------------------------

type GeoResult = { lat: number; lon: number; name: string; detail: string };

const FEATURE_RANK: Record<string, number> = { PPLC: 0, ADM1: 1, PPLA: 1, ADM2: 2, PPLA2: 2, ADM3: 3, PPLA3: 3, ADM4: 4, PPLA4: 4, PPL: 8 };

/** GeoNames 里中文县名经常只有村庄同名条目；去掉后缀、多取几条再按行政级别 / 人口重排。 */
async function openMeteoSearch(name: string, hint: string): Promise<GeoResult[]> {
  type Item = { latitude: number; longitude: number; name?: string; country?: string; country_code?: string; admin1?: string; admin2?: string; feature_code?: string; population?: number };
  const search = async (term: string): Promise<Item[]> => {
    const response = await requestUrl({ url: `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(term)}&count=10&language=zh&format=json` });
    return ((response.json as { results?: Item[] })?.results ?? []).filter((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude));
  };
  let items = await search(name);
  const bare = stripSuffix(name);
  if (items.length === 0 && bare !== name) items = await search(bare);
  const cjk = /[一-鿿]/.test(name);
  const score = (item: Item): number =>
    (FEATURE_RANK[item.feature_code ?? ""] ?? 6) +
    (cjk && item.country_code !== "CN" ? 20 : 0) +
    (hint && !`${item.admin1 ?? ""}${item.admin2 ?? ""}`.includes(hint) ? 10 : 0) -
    Math.min(0.9, Math.log10((item.population ?? 0) + 1) / 10);
  return items
    .map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(({ item }) => ({
      lat: item.latitude,
      lon: item.longitude,
      name: item.name ?? name,
      detail: [item.country, item.admin1, item.admin2].filter(Boolean).join(" · ")
    }));
}

async function fetchOpenMeteo(query: WeatherQuery): Promise<WeatherInfo | undefined> {
  let coords = parseCoords(query.location) ?? parseCoords(query.city);
  let resolved: WeatherLocation | undefined;
  let cityName = query.city.trim();
  if (!coords) {
    const { name, hint } = splitQuery(query.city);
    const best = (await openMeteoSearch(name, hint))[0];
    if (!best) return undefined;
    coords = best;
    cityName = best.name;
    resolved = { id: coordsId(best), name: best.name, detail: best.detail };
  }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
    "&current=temperature_2m,apparent_temperature,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1";
  const response = await requestUrl({ url });
  const json = response.json as {
    current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; is_day?: number };
    daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
  };
  const temp = round(json?.current?.temperature_2m);
  if (temp === undefined) return undefined;
  const isDay = json.current?.is_day === undefined ? isDaytime() : json.current.is_day === 1;
  const info = wmoInfo(Number(json.current?.weather_code ?? -1), isDay);
  return {
    tempC: temp,
    feelsC: round(json.current?.apparent_temperature) ?? temp,
    text: info.text,
    icon: info.icon,
    city: cityName || coordsId(coords),
    high: round(json.daily?.temperature_2m_max?.[0]),
    low: round(json.daily?.temperature_2m_min?.[0]),
    source: "openmeteo",
    resolved
  };
}

/** WMO weather_code → 图标 + 中文描述。 */
export function wmoInfo(code: number, isDay = true): { icon: string; text: string } {
  if (code === 0) return { icon: isDay ? "sun" : "moon", text: "晴" };
  if (code === 1) return { icon: isDay ? "sun" : "moon", text: "晴间多云" };
  if (code === 2) return { icon: isDay ? "cloud-sun" : "cloud-moon", text: "多云" };
  if (code === 3) return { icon: "cloud", text: "阴" };
  if (code === 45 || code === 48) return { icon: "cloud-fog", text: "雾" };
  if (code >= 51 && code <= 57) return { icon: "cloud-drizzle", text: "毛毛雨" };
  if (code >= 61 && code <= 67) return { icon: "cloud-rain", text: "雨" };
  if (code >= 71 && code <= 77) return { icon: "cloud-snow", text: "雪" };
  if (code >= 80 && code <= 82) return { icon: "cloud-rain-wind", text: "阵雨" };
  if (code === 85 || code === 86) return { icon: "cloud-snow", text: "阵雪" };
  if (code >= 95) return { icon: "cloud-lightning", text: "雷雨" };
  return { icon: "cloud", text: "未知" };
}

// ---- 和风天气 --------------------------------------------------------------------

export function normalizeHost(host: string): string {
  return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function qweatherHeaders(query: WeatherQuery): Record<string, string> {
  return { "X-QW-Api-Key": query.qweatherKey.trim() };
}

async function qweatherLookup(query: WeatherQuery, name: string, hint: string): Promise<WeatherLocation[]> {
  const host = normalizeHost(query.qweatherHost);
  if (!host || !query.qweatherKey.trim()) throw new Error("和风天气需要填写 API Host 和 Key");
  const adm = hint ? `&adm=${encodeURIComponent(hint)}` : "";
  const response = await requestUrl({ url: `https://${host}/geo/v2/city/lookup?location=${encodeURIComponent(name)}&number=10${adm}`, headers: qweatherHeaders(query) });
  const json = response.json as { code?: string; location?: Array<{ id?: string; name?: string; adm1?: string; adm2?: string; country?: string }> };
  if (json?.code !== "200" || !Array.isArray(json.location)) return [];
  return json.location
    .filter((item) => item.id && item.name)
    .map((item) => ({ id: String(item.id), name: String(item.name), detail: [item.country, item.adm1, item.adm2].filter(Boolean).join(" · ") }));
}

async function fetchQWeather(query: WeatherQuery): Promise<WeatherInfo | undefined> {
  const host = normalizeHost(query.qweatherHost);
  if (!host || !query.qweatherKey.trim()) return undefined;
  let id = query.location.trim();
  let resolved: WeatherLocation | undefined;
  let cityName = query.city.trim();
  if (!id) {
    const { name, hint } = splitQuery(query.city);
    const best = (await qweatherLookup(query, name, hint))[0];
    if (!best) return undefined;
    id = best.id;
    cityName = best.name;
    resolved = best;
  }
  const headers = qweatherHeaders(query);
  const [nowResponse, dailyResponse] = await Promise.all([
    requestUrl({ url: `https://${host}/v7/weather/now?location=${encodeURIComponent(id)}`, headers }),
    requestUrl({ url: `https://${host}/v7/weather/3d?location=${encodeURIComponent(id)}`, headers }).catch(() => undefined)
  ]);
  const nowJson = nowResponse.json as { code?: string; now?: { temp?: string; feelsLike?: string; text?: string; icon?: string } };
  if (nowJson?.code !== "200" || !nowJson.now) return undefined;
  const temp = round(nowJson.now.temp);
  if (temp === undefined) return undefined;
  const today = (dailyResponse?.json as { daily?: Array<{ tempMax?: string; tempMin?: string }> } | undefined)?.daily?.[0];
  const text = nowJson.now.text || "—";
  return {
    tempC: temp,
    feelsC: round(nowJson.now.feelsLike) ?? temp,
    text,
    icon: qweatherIcon(Number(nowJson.now.icon), text),
    city: cityName || id,
    high: round(today?.tempMax),
    low: round(today?.tempMin),
    source: "qweather",
    resolved
  };
}

/** 和风天气图标代码（100–104 白天、150–154 夜间、3xx 雨、4xx 雪、5xx 雾霾沙尘）。 */
export function qweatherIcon(code: number, text: string): string {
  const night = code >= 150 && code < 200;
  const isDay = !night && isDaytime();
  if (code === 100 || code === 150) return isDay ? "sun" : "moon";
  if ((code >= 101 && code <= 103) || (code >= 151 && code <= 153)) return isDay ? "cloud-sun" : "cloud-moon";
  if (code === 104 || code === 154) return "cloud";
  if (code === 302 || code === 303) return "cloud-lightning";
  if (code === 304 || code === 313 || (code >= 404 && code <= 406) || code === 456 || code === 457) return "cloud-hail";
  if (code === 300 || code === 301 || code === 350 || code === 351) return "cloud-rain-wind";
  if (code === 305 || code === 309) return "cloud-drizzle";
  if (code >= 300 && code < 400) return "cloud-rain";
  if (code >= 400 && code < 500) return "cloud-snow";
  if (code === 502 || (code >= 511 && code <= 513)) return "haze";
  if (code === 503 || code === 504 || code === 507 || code === 508) return "wind";
  if (code >= 500 && code < 520) return "cloud-fog";
  if (code === 900) return "thermometer-sun";
  if (code === 901) return "thermometer-snowflake";
  return iconFromText(text, isDay);
}
