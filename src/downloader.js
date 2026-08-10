// Página de download HLS: busca a playlist .m3u8, deixa o usuário escolher a
// qualidade (playlist master), baixa todos os segmentos, descriptografa
// AES-128 padrão quando presente e junta tudo em um único arquivo.
//
// Não contorna DRM: streams com SAMPLE-AES / Widevine / FairPlay / PlayReady
// são detectados e recusados com uma mensagem clara.

const CONCURRENCY = 4;
const RETRIES = 2;

const params = new URLSearchParams(location.search);
const srcUrl = params.get("src") || "";
const pageTitle = params.get("title") || "video";
const refererUrl = params.get("referer") || "";
const kindParam = params.get("kind") || "hls"; // "hls" | "dash" | "file"
const formatParam = params.get("format") || "mp4"; // "mp4" | "mp3" | "wav"
const bitrateParam = parseInt(params.get("bitrate") || "192", 10);
const audioParam = params.get("audio") || null; // URL de áudio HLS separado, se já escolhido no popup

const steps = {
  loading: document.getElementById("step-loading"),
  quality: document.getElementById("step-quality"),
  progress: document.getElementById("step-progress"),
  done: document.getElementById("step-done"),
  error: document.getElementById("step-error"),
};

const qualityListEl = document.getElementById("quality-list");
const progressBarEl = document.getElementById("progress-bar");
const progressTextEl = document.getElementById("progress-text");
const progressLabelEl = document.getElementById("progress-label");
const doneTextEl = document.getElementById("done-text");
const errorTextEl = document.getElementById("error-text");
const notesEl = document.getElementById("notes");

document.getElementById("video-title").textContent = pageTitle;

const subtituloEl = document.getElementById("subtitulo");
if (subtituloEl) {
  const rotulos = { mp4: "Vídeo (MP4)", mp3: "Áudio (MP3)", wav: "Áudio (WAV)" };
  const sufixoKind = kindParam === "hls" ? " • Stream HLS" : kindParam === "dash" ? " • Stream DASH" : "";
  subtituloEl.textContent = (rotulos[formatParam] || "Vídeo") + sufixoKind;
}

function showStep(name) {
  for (const [key, el] of Object.entries(steps)) {
    el.classList.toggle("hidden", key !== name);
  }
}

function showNote(text) {
  notesEl.textContent = text;
  notesEl.classList.remove("hidden");
}

function fail(message) {
  errorTextEl.textContent = message;
  showStep("error");
}

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// Nome do arquivo baixado: monta a partir de um template configurável pelo
// usuário (padrão de fábrica "{titulo}", igual ao comportamento antigo,
// fixo no código). Placeholders reconhecidos: {titulo}, {site}, {data},
// {hora}, {formato}. Um "sufixo" (ex.: "_audio", pra distinguir a faixa de
// áudio salva à parte de um stream) é sempre aplicado DEPOIS do template,
// não é algo que o usuário controla — existe só pra evitar que dois
// arquivos do mesmo vídeo se sobrescrevam.
// ---------------------------------------------------------------------------

function siteFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function renderFilenameTemplate(template) {
  const now = new Date();
  const dados = {
    titulo: pageTitle,
    site: siteFromUrl(refererUrl) || "video",
    data: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
    hora: `${pad2(now.getHours())}${pad2(now.getMinutes())}`,
    formato: formatParam,
  };
  const resultado = (template || "{titulo}").replace(/\{(\w+)\}/g, (m, chave) =>
    Object.prototype.hasOwnProperty.call(dados, chave) ? dados[chave] : m
  );
  return sanitizeFilename(resultado);
}

// Cache em memória pra não bater no storage a cada arquivo baixado (um
// stream costuma gerar vídeo + áudio como downloads separados na mesma
// página) — a página do downloader é aberta do zero a cada download, então
// o cache não fica desatualizado dentro de uma mesma sessão de download.
let filenameTemplateCache = null;
async function currentFilenameTemplate() {
  if (filenameTemplateCache !== null) return filenameTemplateCache;
  try {
    const { filenameTemplate } = await chrome.storage.local.get({ filenameTemplate: "{titulo}" });
    filenameTemplateCache = filenameTemplate || "{titulo}";
  } catch (e) {
    filenameTemplateCache = "{titulo}";
  }
  return filenameTemplateCache;
}

async function buildFilename(ext, sufixo = "") {
  const template = await currentFilenameTemplate();
  const base = renderFilenameTemplate(template) || "video";
  return `${base}${sufixo}.${ext}`;
}

// Registra o download no histórico (chrome.storage.local, mantido pelo
// background). Best-effort: se a mensagem falhar (ex.: service worker
// reiniciando bem nesse instante), o download em si já foi concluído com
// sucesso — não vale a pena falhar a tela de "concluído" por causa disso.
function recordDownloadHistory({ filename, size, formato }) {
  try {
    chrome.runtime.sendMessage({
      type: "RECORD_DOWNLOAD",
      entry: {
        filename,
        size: size || 0,
        formato: formato || "",
        site: siteFromUrl(refererUrl) || "",
        titulo: pageTitle,
        timestamp: Date.now(),
      },
    });
  } catch (e) {
    // não crítico — ver comentário acima
  }
}

function formatSize(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + " GB";
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

// ---------------------------------------------------------------------------
// Parser de playlists M3U8
// ---------------------------------------------------------------------------

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return attrs;
}

function resolveUrl(url, base) {
  return new URL(url, base).href;
}

const VIDEO_CODEC_PREFIXES = ["avc1", "avc3", "hev1", "hvc1", "av01", "vp09", "vp8", "mp4v"];

// Decide se uma variante do #EXT-X-STREAM-INF é, na prática, só áudio (sem
// faixa de vídeo nenhuma). Regra: sem RESOLUTION e com CODECS que não cita
// nenhum codec de vídeo conhecido. Se não tiver CODECS pra checar, assume
// vídeo (não esconde uma variante válida por falta de informação).
function isAudioOnlyVariant(attrs) {
  if (attrs.RESOLUTION) return false;
  const codecs = (attrs.CODECS || "").toLowerCase();
  if (!codecs) return false;
  return !VIDEO_CODEC_PREFIXES.some((p) => codecs.includes(p));
}

function parsePlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length || !lines[0].startsWith("#EXTM3U")) {
    throw new Error("O conteúdo não é uma playlist M3U8 válida.");
  }

  const isMaster = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF:"));

  if (isMaster) {
    const variants = [];
    const audioRenditions = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
        if (attrs.TYPE === "AUDIO" && attrs.URI) {
          audioRenditions.push({
            groupId: attrs["GROUP-ID"] || "",
            name: attrs.NAME || "áudio",
            isDefault: attrs.DEFAULT === "YES",
            url: resolveUrl(attrs.URI, baseUrl),
          });
        }
      }

      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
        // Algumas playlists master incluem variantes "de vídeo" que na
        // verdade só têm áudio (renditions alternativas de bitrate baixo,
        // sem faixa de vídeo nenhuma). Sem RESOLUTION e sem um codec de
        // vídeo reconhecível nos CODECS, é áudio disfarçado de variante —
        // não deve virar opção de qualidade em MP4.
        if (isAudioOnlyVariant(attrs)) continue;
        // A URI da variante é a próxima linha que não é comentário.
        for (let j = i + 1; j < lines.length; j++) {
          if (!lines[j].startsWith("#")) {
            variants.push({
              url: resolveUrl(lines[j], baseUrl),
              bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0,
              resolution: attrs.RESOLUTION || "",
              codecs: attrs.CODECS || "",
              audioGroup: attrs.AUDIO || "",
            });
            break;
          }
        }
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { type: "master", variants, audioRenditions };
  }

  // Playlist de mídia (lista de segmentos).
  const segments = [];
  let currentKey = null;
  let map = null;
  let mediaSequence = 0;
  let live = true;

  // Passada sequencial: uma linha sem "#" logo após um #EXTINF é a URI do
  // segmento; a chave em vigor (#EXT-X-KEY) se aplica aos segmentos seguintes.
  let expectingSegment = false;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      mediaSequence = parseInt(line.split(":")[1], 10) || 0;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      live = false;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attrs.URI) map = { url: resolveUrl(attrs.URI, baseUrl) };
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-KEY:".length));
      const method = attrs.METHOD || "NONE";
      if (method === "NONE") {
        currentKey = null;
      } else {
        currentKey = {
          method,
          uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : "",
          iv: attrs.IV || "",
          keyFormat: attrs.KEYFORMAT || "identity",
        };
      }
    } else if (line.startsWith("#EXTINF:")) {
      expectingSegment = true;
    } else if (expectingSegment && !line.startsWith("#")) {
      segments.push({
        url: resolveUrl(line, baseUrl),
        key: currentKey,
        sequence: mediaSequence + segments.length,
      });
      expectingSegment = false;
    }
  }

  return { type: "media", segments, map, live };
}

function checkDrm(playlist) {
  for (const seg of playlist.segments) {
    if (!seg.key) continue;
    const method = seg.key.method.toUpperCase();
    const format = (seg.key.keyFormat || "identity").toLowerCase();
    if (method !== "AES-128" || format !== "identity") {
      throw new Error(
        "Este vídeo é protegido por DRM (" +
          seg.key.method +
          "). A extensão não baixa conteúdo protegido."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Parser de manifestos DASH (.mpd)
// ---------------------------------------------------------------------------
// Suporta o caso mais comum na prática: representações fMP4/CMAF descritas
// via SegmentTemplate (com SegmentTimeline explícita ou @duration fixa).
// SegmentBase/SegmentList (comum em MPDs mais antigos/simples, um único
// arquivo com byte-ranges) não é suportado — a representação é listada mas
// o download falha com uma mensagem clara explicando o motivo. Streams com
// <ContentProtection> (Widevine/PlayReady/qualquer DRM) são recusados, assim
// como o SAMPLE-AES é recusado no HLS: esta extensão não contorna DRM.

function parseIsoDuration(str) {
  if (!str) return 0;
  const m = String(str).match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!m) return 0;
  const h = parseFloat(m[1] || 0);
  const mnt = parseFloat(m[2] || 0);
  const s = parseFloat(m[3] || 0);
  return h * 3600 + mnt * 60 + s;
}

function getDirectBaseUrl(el, parentBase) {
  const baseEl = el.querySelector(":scope > BaseURL");
  if (baseEl && baseEl.textContent) return resolveUrl(baseEl.textContent.trim(), parentBase);
  return parentBase;
}

function fillDashTemplate(template, vars) {
  let out = template.replace(/\$(RepresentationID|Bandwidth|Time|Number)(?:%0(\d+)d)?\$/g, (m, key, width) => {
    const val = vars[key];
    if (val === undefined || val === null) return m;
    return width ? String(val).padStart(parseInt(width, 10), "0") : String(val);
  });
  return out.replace(/\$\$/g, "$");
}

function extractSegmentTemplate(el) {
  if (!el) return null;
  const timelineEl = el.querySelector(":scope > SegmentTimeline");
  let timeline = null;
  if (timelineEl) {
    timeline = Array.from(timelineEl.querySelectorAll(":scope > S")).map((s) => ({
      t: s.hasAttribute("t") ? parseInt(s.getAttribute("t"), 10) : null,
      d: parseInt(s.getAttribute("d"), 10),
      r: s.hasAttribute("r") ? parseInt(s.getAttribute("r"), 10) : 0,
    }));
  }
  return {
    initialization: el.getAttribute("initialization") || null,
    media: el.getAttribute("media") || null,
    startNumber: el.hasAttribute("startNumber") ? parseInt(el.getAttribute("startNumber"), 10) : 1,
    timescale: el.hasAttribute("timescale") ? parseInt(el.getAttribute("timescale"), 10) : 1,
    duration: el.hasAttribute("duration") ? parseInt(el.getAttribute("duration"), 10) : null,
    timeline,
  };
}

function parseMpd(xmlText, baseUrl) {
  const doc = new DOMParser().parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Manifesto DASH (.mpd) inválido.");

  const mpdEl = doc.documentElement;
  if (!mpdEl || mpdEl.tagName !== "MPD") throw new Error("O conteúdo não é um manifesto DASH (.mpd) válido.");

  const isLive = mpdEl.getAttribute("type") === "dynamic";
  const mpdDuration = parseIsoDuration(mpdEl.getAttribute("mediaPresentationDuration"));
  const mpdBase = getDirectBaseUrl(mpdEl, baseUrl);

  const period = mpdEl.querySelector(":scope > Period");
  if (!period) throw new Error("Manifesto DASH sem nenhum <Period>.");
  const periodBase = getDirectBaseUrl(period, mpdBase);
  const periodDuration = parseIsoDuration(period.getAttribute("duration")) || mpdDuration;

  const videoReps = [];
  const audioReps = [];

  period.querySelectorAll(":scope > AdaptationSet").forEach((as) => {
    const asBase = getDirectBaseUrl(as, periodBase);
    const mimeType = as.getAttribute("mimeType") || "";
    const contentType =
      as.getAttribute("contentType") ||
      (mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "");
    if (contentType !== "video" && contentType !== "audio") return;

    const asHasDrm = as.querySelector(":scope > ContentProtection") !== null;
    const asSegTemplateEl = as.querySelector(":scope > SegmentTemplate");

    as.querySelectorAll(":scope > Representation").forEach((repEl) => {
      const repBase = getDirectBaseUrl(repEl, asBase);
      const hasSegmentBaseOrList = !!(
        repEl.querySelector(":scope > SegmentBase") || repEl.querySelector(":scope > SegmentList")
      );

      const rep = {
        id: repEl.getAttribute("id") || "",
        bandwidth: parseInt(repEl.getAttribute("bandwidth") || "0", 10),
        width: repEl.getAttribute("width") || "",
        height: repEl.getAttribute("height") || "",
        codecs: repEl.getAttribute("codecs") || as.getAttribute("codecs") || "",
        baseUrl: repBase,
        segmentTemplateEl: repEl.querySelector(":scope > SegmentTemplate") || asSegTemplateEl,
        hasSegmentBaseOrList,
        drm: asHasDrm || repEl.querySelector(":scope > ContentProtection") !== null,
      };

      (contentType === "video" ? videoReps : audioReps).push(rep);
    });
  });

  videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
  audioReps.sort((a, b) => b.bandwidth - a.bandwidth);

  if (!videoReps.length) throw new Error("O manifesto DASH não contém nenhuma representação de vídeo.");

  return { isLive, periodDuration, videoReps, audioReps };
}

// Resolve a lista de URLs (init + segmentos de mídia) de uma representação,
// a partir do seu SegmentTemplate. Lança erro com mensagem clara para os
// casos não suportados (SegmentBase/SegmentList, ausência de duração para
// calcular o número de segmentos, etc.).
function getRepSegmentUrls(rep, periodDuration) {
  if (rep.hasSegmentBaseOrList) {
    throw new Error(
      "Esta representação usa SegmentBase/SegmentList em vez de SegmentTemplate — esse formato de DASH ainda não é suportado."
    );
  }
  if (!rep.segmentTemplateEl) {
    throw new Error("Representação sem SegmentTemplate — esse formato de DASH ainda não é suportado.");
  }

  const segTemplate = extractSegmentTemplate(rep.segmentTemplateEl);
  if (!segTemplate.media) throw new Error("SegmentTemplate sem o atributo 'media'.");

  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const initUrl = segTemplate.initialization
    ? resolveUrl(fillDashTemplate(segTemplate.initialization, vars), rep.baseUrl)
    : null;

  const mediaTemplates = [];
  if (segTemplate.timeline && segTemplate.timeline.length) {
    let time = 0;
    let number = segTemplate.startNumber;
    for (const s of segTemplate.timeline) {
      if (s.t != null) time = s.t;
      for (let i = 0; i <= s.r; i++) {
        mediaTemplates.push(fillDashTemplate(segTemplate.media, { ...vars, Number: number, Time: time }));
        time += s.d;
        number++;
      }
    }
  } else if (segTemplate.duration) {
    if (!periodDuration) {
      throw new Error(
        "Não foi possível calcular o número de segmentos (stream ao vivo sem SegmentTimeline e sem duração conhecida)."
      );
    }
    const segDurationSec = segTemplate.duration / segTemplate.timescale;
    const count = Math.ceil(periodDuration / segDurationSec);
    for (let i = 0; i < count; i++) {
      mediaTemplates.push(fillDashTemplate(segTemplate.media, { ...vars, Number: segTemplate.startNumber + i }));
    }
  } else {
    throw new Error("SegmentTemplate sem SegmentTimeline nem @duration — formato inesperado.");
  }

  return { initUrl, mediaUrls: mediaTemplates.map((t) => resolveUrl(t, rep.baseUrl)) };
}

function checkDashDrm(rep) {
  if (rep.drm) {
    throw new Error(
      "Este vídeo é protegido por DRM (DASH Content Protection). A extensão não baixa conteúdo protegido."
    );
  }
}

// Como buildMediaBlob, mas para uma representação DASH: baixa o init segment
// + todos os segmentos de mídia e junta em um único Blob.
async function buildDashMediaBlob(rep, periodDuration, { audioOnly = false } = {}) {
  checkDashDrm(rep);
  const { initUrl, mediaUrls } = getRepSegmentUrls(rep, periodDuration);

  showStep("progress");
  progressLabelEl.textContent = audioOnly ? "Baixando áudio…" : "Baixando segmentos…";

  const parts = [];
  if (initUrl) parts.push(await fetchWithRetry(initUrl, false));

  const segments = mediaUrls.map((url) => ({ url, key: null }));
  const segmentData = await downloadSegments(segments, (done, total, results) => {
    const downloadedBytes = results.reduce((acc, b) => acc + (b ? b.byteLength : 0), 0);
    const pct = Math.round((done / total) * 100);
    progressBarEl.style.width = pct + "%";
    progressTextEl.textContent = `${done} de ${total} segmentos • ${formatSize(downloadedBytes)}`;
  });
  parts.push(...segmentData);

  const ext = audioOnly ? "m4a" : "mp4";
  const mime = audioOnly ? "audio/mp4" : "video/mp4";
  return { blob: new Blob(parts, { type: mime }), ext };
}

// Como buildFmp4Parts, mas para uma representação DASH: devolve o init
// segment e os fragmentos crus separados, para o mux automático de
// vídeo+áudio (reaproveita o mesmo muxFmp4 usado pelo HLS — o formato dos
// fragmentos fMP4/CMAF é idêntico).
async function buildDashFmp4Parts(rep, periodDuration) {
  checkDashDrm(rep);
  const { initUrl, mediaUrls } = getRepSegmentUrls(rep, periodDuration);
  if (!initUrl) throw new Error("SegmentTemplate sem 'initialization' — não é fMP4.");

  const initBuffer = await fetchWithRetry(initUrl, false);
  if (typeof looksLikeFmp4 !== "function" || !looksLikeFmp4(initBuffer)) {
    throw new Error("Init segment não parece fMP4 válido.");
  }

  const segments = mediaUrls.map((url) => ({ url, key: null }));
  const fragBuffers = await downloadSegments(segments, () => {});
  return { initBuffer, fragBuffers };
}

// ---------------------------------------------------------------------------
// Cabeçalhos anti-hotlink
// ---------------------------------------------------------------------------
// Muitos servidores de vídeo só respondem se o pedido vier com o
// Referer/Origin da página original (proteção contra hotlink) — sem isso o
// retorno é HTTP 403. Como fetch() não permite definir esses cabeçalhos,
// usamos uma regra de sessão do declarativeNetRequest, restrita às
// requisições feitas por esta aba.

let headerRuleId = null;

async function setupHeaderRule() {
  if (!refererUrl || !chrome.declarativeNetRequest) return;

  let origin;
  try {
    origin = new URL(refererUrl).origin;
  } catch (e) {
    return;
  }

  const tab = await chrome.tabs.getCurrent();
  if (!tab) return;

  headerRuleId = tab.id; // único por aba de download
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [headerRuleId],
    addRules: [
      {
        id: headerRuleId,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: refererUrl },
            { header: "Origin", operation: "set", value: origin },
          ],
        },
        condition: {
          tabIds: [tab.id],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
}

function removeHeaderRule() {
  if (headerRuleId !== null && chrome.declarativeNetRequest) {
    chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [headerRuleId] });
    headerRuleId = null;
  }
}

window.addEventListener("pagehide", removeHeaderRule);

function friendlyError(e) {
  const message = e && e.message ? e.message : String(e);
  if (/HTTP 40[13]/.test(message)) {
    return (
      "O servidor recusou o download (" + message + "). " +
      "Isso costuma acontecer quando o link do vídeo expira, ou quando o site exige algo a mais que a extensão não está mandando na requisição. " +
      "Volte à página, recarregue-a, dê play no vídeo e tente baixar logo em seguida."
    );
  }
  return message;
}

// ---------------------------------------------------------------------------
// Download de segmentos
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, asText) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return asText ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

const keyCache = new Map();

async function getKey(uri) {
  if (!keyCache.has(uri)) {
    const raw = await fetchWithRetry(uri, false);
    const cryptoKey = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
    keyCache.set(uri, cryptoKey);
  }
  return keyCache.get(uri);
}

function ivForSegment(segment) {
  if (segment.key.iv) {
    // IV explícito em hexadecimal ("0x...").
    const hex = segment.key.iv.replace(/^0x/i, "").padStart(32, "0");
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    return iv;
  }
  // Sem IV explícito: usa o número de sequência em big-endian (padrão HLS).
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, segment.sequence);
  return iv;
}

async function fetchSegment(segment) {
  let data = await fetchWithRetry(segment.url, false);
  if (segment.key) {
    const key = await getKey(segment.key.uri);
    data = await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivForSegment(segment) }, key, data);
  }
  return data;
}

async function downloadSegments(segments, onProgress) {
  const results = new Array(segments.length);
  let next = 0;
  let done = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, segments.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= segments.length) return;
      results[i] = await fetchSegment(segments[i]);
      done++;
      onProgress(done, segments.length, results);
    }
  });

  await Promise.all(workers);
  return results;
}

function outputExtension(playlist, audioOnly) {
  const firstUrl = (playlist.map && playlist.map.url) || (playlist.segments[0] && playlist.segments[0].url) || "";
  const isFmp4 = !!playlist.map || /\.(m4s|mp4|m4a)(\?|#|$)/i.test(firstUrl);
  if (audioOnly) return isFmp4 ? "m4a" : "ts";
  return isFmp4 ? "mp4" : "ts";
}

// Baixa e monta os segmentos de uma playlist de mídia HLS em um único Blob,
// sem disparar o download — usado tanto pelo fluxo de vídeo (que depois
// dispara o download) quanto pela extração de áudio (que ainda precisa
// decodificar/recodificar o Blob antes de salvar).
async function buildMediaBlob(url, { audioOnly = false } = {}) {
  const text = await fetchWithRetry(url, true);
  const playlist = parsePlaylist(text, url);

  if (playlist.type === "master") {
    throw new Error("Playlist inesperada (master dentro de master).");
  }
  if (!playlist.segments.length) {
    throw new Error("A playlist não contém segmentos de vídeo.");
  }

  checkDrm(playlist);

  if (playlist.live) {
    showNote(
      "Este stream parece ser uma transmissão ao vivo: será baixado apenas o trecho disponível agora."
    );
  }

  showStep("progress");
  progressLabelEl.textContent = audioOnly ? "Baixando áudio…" : "Baixando segmentos…";

  const parts = [];
  if (playlist.map) {
    parts.push(await fetchWithRetry(playlist.map.url, false));
  }

  let downloadedBytes = parts.reduce((acc, b) => acc + b.byteLength, 0);
  const segmentData = await downloadSegments(playlist.segments, (done, total, results) => {
    downloadedBytes = results.reduce((acc, b) => acc + (b ? b.byteLength : 0), 0);
    const pct = Math.round((done / total) * 100);
    progressBarEl.style.width = pct + "%";
    progressTextEl.textContent = `${done} de ${total} segmentos • ${formatSize(downloadedBytes)}`;
  });

  parts.push(...segmentData);

  const ext = outputExtension(playlist, audioOnly);
  const mime = ext === "ts" ? "video/mp2t" : audioOnly ? "audio/mp4" : "video/mp4";
  const blob = new Blob(parts, { type: mime });
  return { blob, ext };
}

// Como buildMediaBlob, mas devolve o init segment e os fragmentos crus
// (sem concatenar) — usado pelo mux automático de vídeo+áudio, que precisa
// reescrever campos dentro de cada moof/moov antes de juntar tudo.
async function buildFmp4Parts(url) {
  const text = await fetchWithRetry(url, true);
  const playlist = parsePlaylist(text, url);

  if (playlist.type === "master") {
    throw new Error("Playlist inesperada (master dentro de master).");
  }
  if (!playlist.segments.length) {
    throw new Error("A playlist não contém segmentos.");
  }
  if (!playlist.map) {
    throw new Error("Stream não é fMP4 (sem EXT-X-MAP) — remux automático não se aplica.");
  }

  checkDrm(playlist);

  const initBuffer = await fetchWithRetry(playlist.map.url, false);
  if (typeof looksLikeFmp4 !== "function" || !looksLikeFmp4(initBuffer)) {
    throw new Error("Init segment não parece fMP4 válido.");
  }

  const fragBuffers = await downloadSegments(playlist.segments, () => {});
  return { initBuffer, fragBuffers };
}

async function downloadMediaPlaylist(url, { audioOnly = false, suffix = "" } = {}) {
  const { blob, ext } = await buildMediaBlob(url, { audioOnly });
  const filename = await buildFilename(ext, suffix);

  const objectUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: objectUrl, filename });
  recordDownloadHistory({ filename, size: blob.size, formato: ext });

  return { filename, size: blob.size, ext };
}

// Busca um arquivo direto (não-playlist) com o cabeçalho Range presente.
// Alguns CDNs de vídeo (o do TikTok entre eles) recusam a requisição com
// 403 quando ela não parece vir de um player de verdade — e um player real
// sempre manda "Range" ao carregar um vídeo, mesmo pedindo o arquivo
// inteiro. "bytes=0-" pede do início ao fim (o arquivo completo), então o
// resultado é o mesmo de um fetch normal, só que aceito por esses CDNs.
async function fetchDirectFile(url) {
  const res = await fetch(url, { credentials: "include", headers: { Range: "bytes=0-" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res;
}

// Confere se um blob de vídeo "arquivo direto" é mesmo um MP4 completo
// (caixa ISOBMFF "ftyp" logo no início) e não, por exemplo, um pedaço solto
// de um stream fragmentado (caixa "styp") que tenha escapado do filtro do
// service worker, ou uma página de erro/login disfarçada de vídeo (ex.:
// HTML de "faça login para continuar" servido com content-type video/mp4).
// Só se aplica a .mp4/.m4v — outros containers (webm/ogg/mov) têm assinatura
// diferente e não passam por aqui. Não bloqueia o download em caso de
// dúvida (extensão desconhecida ou bytes insuficientes): só recusa quando
// tem certeza de que não é um MP4 válido.
async function assertLikelyCompleteMp4(blob, ext) {
  if (ext !== "mp4" && ext !== "m4v") return;
  if (blob.size < 12) {
    throw new Error("O arquivo baixado está vazio ou incompleto demais para ser um vídeo válido.");
  }
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const boxType = String.fromCharCode(head[4], head[5], head[6], head[7]);
  if (boxType === "styp") {
    throw new Error(
      "O link capturado é só um pedaço de um vídeo fragmentado (stream), não o arquivo completo — recarregue a página do vídeo e tente novamente."
    );
  }
  if (boxType !== "ftyp") {
    throw new Error(
      "O conteúdo baixado não parece ser um vídeo MP4 válido (pode ser uma página de erro ou de login do site, ou o link pode ter expirado)."
    );
  }
}

// Reúne o Blob de mídia bruta a partir do qual o áudio será extraído,
// tanto para arquivos diretos quanto para streams HLS (master ou mídia).
// Para HLS, prioriza a faixa de áudio separada quando existe (mais leve e
// rápida de baixar do que o vídeo completo); senão usa a variante de menor
// bitrate, já que a qualidade do áudio costuma ser igual entre variantes.
async function buildSourceBlobForAudio() {
  if (kindParam === "file") {
    progressLabelEl.textContent = "Baixando mídia…";
    showStep("progress");
    const res = await fetchDirectFile(srcUrl);
    return await res.blob();
  }

  if (kindParam === "dash") {
    const mpdText = await fetchWithRetry(srcUrl, true);
    const mpd = parseMpd(mpdText, srcUrl);
    // Prioriza a faixa de áudio separada (mais leve); sem ela, cai para a
    // variante de vídeo de menor bitrate — mesma lógica usada para HLS.
    const rep = mpd.audioReps.length
      ? mpd.audioReps[0]
      : [...mpd.videoReps].sort((a, b) => a.bandwidth - b.bandwidth)[0];
    const { blob } = await buildDashMediaBlob(rep, mpd.periodDuration, { audioOnly: true });
    return blob;
  }

  const text = await fetchWithRetry(srcUrl, true);
  const playlist = parsePlaylist(text, srcUrl);

  if (playlist.type === "master") {
    if (!playlist.variants.length) {
      throw new Error("A playlist master não contém variantes de vídeo.");
    }
    let mediaUrl;
    if (playlist.audioRenditions.length) {
      const escolhida =
        playlist.audioRenditions.find((a) => a.isDefault) || playlist.audioRenditions[0];
      mediaUrl = escolhida.url;
    } else {
      mediaUrl = [...playlist.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0].url;
    }
    const { blob } = await buildMediaBlob(mediaUrl, { audioOnly: true });
    return blob;
  }

  const { blob } = await buildMediaBlob(srcUrl, { audioOnly: true });
  return blob;
}

async function startAudioExtraction(formato, bitrateKbps) {
  try {
    const blob = await buildSourceBlobForAudio();

    showStep("progress");
    progressLabelEl.textContent = "Extraindo áudio…";
    progressBarEl.style.width = "70%";
    progressTextEl.textContent = "";

    // Dá um respiro para a UI atualizar antes do trabalho pesado de decodificação.
    await new Promise((r) => setTimeout(r, 30));

    progressLabelEl.textContent = formato === "mp3" ? "Codificando MP3…" : "Gerando WAV…";
    progressBarEl.style.width = "85%";

    const outBlob = await extractAudio(blob, formato, bitrateKbps);

    const filename = await buildFilename(formato);
    const objectUrl = URL.createObjectURL(outBlob);
    await chrome.downloads.download({ url: objectUrl, filename });
    recordDownloadHistory({ filename, size: outBlob.size, formato });

    progressBarEl.style.width = "100%";
    doneTextEl.textContent = `Arquivo "${filename}" (${formatSize(outBlob.size)}) enviado para a pasta de downloads.`;
    showStep("done");
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

// ---------------------------------------------------------------------------
// Fluxo principal
// ---------------------------------------------------------------------------

// Tenta baixar vídeo e áudio separadamente e juntá-los em um único MP4, sem
// recodificar (só funciona para streams fMP4/CMAF — o formato usado pelo
// X/Twitter e a maioria dos players modernos). Lança erro se o stream não
// se encaixar nesse caso, para o chamador cair de volta ao fluxo antigo.
async function tryAutoMux(variantUrl, audioUrl) {
  progressLabelEl.textContent = "Baixando vídeo…";
  showStep("progress");
  const video = await buildFmp4Parts(variantUrl);

  progressLabelEl.textContent = "Baixando áudio…";
  const audio = await buildFmp4Parts(audioUrl);

  progressLabelEl.textContent = "Juntando vídeo e áudio…";
  progressBarEl.style.width = "90%";
  await new Promise((r) => setTimeout(r, 20)); // respiro pra UI atualizar

  const blob = muxFmp4({
    videoInit: video.initBuffer,
    videoFrags: video.fragBuffers,
    audioInit: audio.initBuffer,
    audioFrags: audio.fragBuffers,
  });

  const filename = await buildFilename("mp4");
  const objectUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: objectUrl, filename });
  recordDownloadHistory({ filename, size: blob.size, formato: "mp4" });

  return { filename, size: blob.size };
}

async function startDownload(variantUrl, audioUrl) {
  if (audioUrl && typeof muxFmp4 === "function") {
    try {
      const result = await tryAutoMux(variantUrl, audioUrl);
      doneTextEl.textContent = `Arquivo "${result.filename}" (${formatSize(result.size)}) enviado para a pasta de downloads — vídeo e áudio já juntos.`;
      showStep("done");
      return;
    } catch (e) {
      console.warn("Mux automático falhou, caindo para o fluxo de dois arquivos:", e);
      showNote(
        "Não foi possível juntar vídeo e áudio automaticamente para este stream (" +
          (e && e.message ? e.message : String(e)) +
          "). Baixando os dois separadamente."
      );
    }
  }

  try {
    const result = await downloadMediaPlaylist(variantUrl);

    let doneText = `Arquivo "${result.filename}" (${formatSize(result.size)}) enviado para a pasta de downloads.`;

    if (audioUrl) {
      const audio = await downloadMediaPlaylist(audioUrl, { audioOnly: true, suffix: "_audio" });
      doneText +=
        ` O áudio deste stream é separado do vídeo e foi salvo como "${audio.filename}".` +
        " Para juntar os dois em um arquivo só é preciso um conversor como o FFmpeg.";
    }

    if (result.ext === "ts") {
      doneText += " Arquivos .ts abrem no VLC; para .mp4 use um conversor.";
    }

    doneTextEl.textContent = doneText;
    showStep("done");
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

// ---------------------------------------------------------------------------
// Fluxo DASH — espelha o fluxo HLS acima, mas a partir de representações do
// manifesto .mpd em vez de variantes de playlist M3U8.
// ---------------------------------------------------------------------------

function labelForDashRep(rep) {
  const parts = [];
  if (rep.width && rep.height) parts.push(`${rep.width}x${rep.height}`);
  if (rep.bandwidth) parts.push(Math.round(rep.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || rep.id || "Qualidade padrão";
}

function pickBestAudioRep(audioReps) {
  const usaveis = audioReps.filter((a) => !a.drm);
  return usaveis.length ? usaveis[0] : null; // já vem ordenado por bandwidth desc
}

async function startDashDownload(rep, audioRep, periodDuration) {
  try {
    checkDashDrm(rep);
    if (audioRep) checkDashDrm(audioRep);
  } catch (e) {
    fail(friendlyError(e));
    return;
  }

  if (audioRep && typeof muxFmp4 === "function") {
    try {
      progressLabelEl.textContent = "Baixando vídeo…";
      showStep("progress");
      const video = await buildDashFmp4Parts(rep, periodDuration);

      progressLabelEl.textContent = "Baixando áudio…";
      const audio = await buildDashFmp4Parts(audioRep, periodDuration);

      progressLabelEl.textContent = "Juntando vídeo e áudio…";
      progressBarEl.style.width = "90%";
      await new Promise((r) => setTimeout(r, 20));

      const blob = muxFmp4({
        videoInit: video.initBuffer,
        videoFrags: video.fragBuffers,
        audioInit: audio.initBuffer,
        audioFrags: audio.fragBuffers,
      });

      const filename = await buildFilename("mp4");
      const objectUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: objectUrl, filename });
      recordDownloadHistory({ filename, size: blob.size, formato: "mp4" });

      doneTextEl.textContent = `Arquivo "${filename}" (${formatSize(blob.size)}) enviado para a pasta de downloads — vídeo e áudio já juntos.`;
      showStep("done");
      return;
    } catch (e) {
      console.warn("Mux automático (DASH) falhou, caindo para o fluxo de dois arquivos:", e);
      showNote(
        "Não foi possível juntar vídeo e áudio automaticamente para este stream DASH (" +
          (e && e.message ? e.message : String(e)) +
          "). Baixando os dois separadamente."
      );
    }
  }

  try {
    const { blob, ext } = await buildDashMediaBlob(rep, periodDuration);
    const filename = await buildFilename(ext);
    const objectUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({ url: objectUrl, filename });
    recordDownloadHistory({ filename, size: blob.size, formato: ext });

    let doneText = `Arquivo "${filename}" (${formatSize(blob.size)}) enviado para a pasta de downloads.`;

    if (audioRep) {
      const audioResult = await buildDashMediaBlob(audioRep, periodDuration, { audioOnly: true });
      const audioFilename = await buildFilename(audioResult.ext, "_audio");
      const audioObjectUrl = URL.createObjectURL(audioResult.blob);
      await chrome.downloads.download({ url: audioObjectUrl, filename: audioFilename });
      recordDownloadHistory({ filename: audioFilename, size: audioResult.blob.size, formato: audioResult.ext });
      doneText +=
        ` O áudio deste stream é separado do vídeo e foi salvo como "${audioFilename}".` +
        " Para juntar os dois em um arquivo só é preciso um conversor como o FFmpeg.";
    }

    doneTextEl.textContent = doneText;
    showStep("done");
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

function renderDashQualityChoices(mpd) {
  showStep("quality");
  qualityListEl.innerHTML = "";

  const audioRep = pickBestAudioRep(mpd.audioReps);

  mpd.videoReps.forEach((rep) => {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = labelForDashRep(rep) + (rep.drm ? " 🔒" : "");

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => startDashDownload(rep, audioRep, mpd.periodDuration));

    li.appendChild(label);
    li.appendChild(btn);
    qualityListEl.appendChild(li);
  });
}

async function handleDashFlow() {
  const mpdText = await fetchWithRetry(srcUrl, true);
  const mpd = parseMpd(mpdText, srcUrl);

  if (mpd.isLive) {
    showNote(
      "Este stream parece ser uma transmissão DASH ao vivo: será baixado apenas o trecho disponível agora, quando for possível calculá-lo."
    );
  }

  // Se o popup já escolheu a representação (fluxo normal: escolha de
  // qualidade acontece no próprio popup), baixa direto sem mostrar o
  // seletor de novo.
  const repIdParam = params.get("rep");
  if (repIdParam) {
    const rep = mpd.videoReps.find((r) => r.id === repIdParam);
    if (!rep) {
      fail("Representação de vídeo não encontrada no manifesto (o link pode ter expirado — recarregue a página e tente de novo).");
      return;
    }
    const audioRepIdParam = params.get("audioRep");
    const audioRep = audioRepIdParam ? mpd.audioReps.find((r) => r.id === audioRepIdParam) || null : null;
    await startDashDownload(rep, audioRep, mpd.periodDuration);
    return;
  }

  renderDashQualityChoices(mpd);
}

function labelForVariant(variant) {
  const parts = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(Math.round(variant.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || "Qualidade padrão";
}

function pickAudioUrl(variant, audioRenditions) {
  if (!variant.audioGroup || !audioRenditions.length) return null;
  const group = audioRenditions.filter((a) => a.groupId === variant.audioGroup);
  if (!group.length) return null;
  const chosen = group.find((a) => a.isDefault) || group[0];
  return chosen.url;
}

function renderQualityChoices(master) {
  showStep("quality");
  qualityListEl.innerHTML = "";

  master.variants.forEach((variant) => {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = labelForVariant(variant);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => {
      startDownload(variant.url, pickAudioUrl(variant, master.audioRenditions));
    });

    li.appendChild(label);
    li.appendChild(btn);
    qualityListEl.appendChild(li);
  });
}

async function init() {
  if (!srcUrl) {
    fail("Nenhuma URL informada.");
    return;
  }

  try {
    // Instala a regra de Referer/Origin antes de qualquer requisição.
    await setupHeaderRule();

    // Extração de áudio (MP3/WAV): funciona tanto para arquivo direto
    // quanto para stream HLS, e não usa o seletor de qualidade de vídeo.
    if (formatParam === "mp3" || formatParam === "wav") {
      await startAudioExtraction(formatParam, bitrateParam);
      return;
    }

    // Fluxo de vídeo (MP4).
    if (kindParam === "file") {
      // Download direto de arquivo: normalmente tratado no popup, mas
      // suportado aqui também para manter um único ponto de entrada.
      showStep("progress");
      progressLabelEl.textContent = "Baixando vídeo…";
      const res = await fetchDirectFile(srcUrl);
      const blob = await res.blob();
      const ext = extensionFromSrc(srcUrl);
      await assertLikelyCompleteMp4(blob, ext);
      const filename = await buildFilename(ext);
      const objectUrl = URL.createObjectURL(blob);
      await chrome.downloads.download({ url: objectUrl, filename });
      recordDownloadHistory({ filename, size: blob.size, formato: ext });
      doneTextEl.textContent = `Arquivo "${filename}" (${formatSize(blob.size)}) enviado para a pasta de downloads.`;
      showStep("done");
      return;
    }

    if (kindParam === "dash") {
      await handleDashFlow();
      return;
    }

    const text = await fetchWithRetry(srcUrl, true);
    const playlist = parsePlaylist(text, srcUrl);

    if (playlist.type === "master") {
      if (!playlist.variants.length) {
        fail("A playlist master não contém variantes de vídeo.");
        return;
      }
      renderQualityChoices(playlist);
    } else {
      // Playlist de mídia direta (variante já escolhida no popup): baixa
      // sem mostrar o seletor de qualidade de novo.
      await startDownload(srcUrl, audioParam);
    }
  } catch (e) {
    console.error(e);
    fail(friendlyError(e));
  }
}

function extensionFromSrc(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "mp4";
  } catch (e) {
    return "mp4";
  }
}

init();
