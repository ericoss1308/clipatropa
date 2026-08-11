// Lógica do popup: busca a lista de vídeos da aba ativa e renderiza cada um
// com uma prévia clicável. Clicar na prévia expande um painel com os
// formatos (MP4 / MP3 / WAV); clicar em um formato lista as
// qualidades/resoluções disponíveis para aquele formato.

const listEl = document.getElementById("video-list");
const emptyEl = document.getElementById("empty");
const restrictedEl = document.getElementById("restricted");
const restrictedNomeEl = document.getElementById("restricted-nome");

const FORMATOS = ["mp4", "mp3", "wav"];
const BITRATES_MP3 = [320, 192, 128];

let itemAbertoEl = null;

function sanitizeFilename(name) {
  return (name || "video")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "mp4";
  } catch (e) {
    return "mp4";
  }
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return mb.toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ---------------------------------------------------------------------------
// Parser mínimo de playlist M3U8 master, só para listar as variantes
// (resolução/bitrate) na prévia. O download em si usa o parser completo em
// downloader.js.
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

function parseMasterVariants(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines.length || !lines[0].startsWith("#EXTM3U")) {
    throw new Error("Playlist M3U8 inválida.");
  }

  const variants = [];
  const audioRenditions = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      if (attrs.TYPE === "AUDIO" && attrs.URI) {
        audioRenditions.push({
          groupId: attrs["GROUP-ID"] || "",
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
      // não deve aparecer como opção de qualidade em MP4.
      if (isAudioOnlyVariant(attrs)) continue;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          variants.push({
            url: resolveUrl(lines[j], baseUrl),
            bandwidth: parseInt(attrs.BANDWIDTH || "0", 10) || 0,
            resolution: attrs.RESOLUTION || "",
            audioGroup: attrs.AUDIO || "",
          });
          break;
        }
      }
    }
  }

  if (!variants.length) {
    // Não é uma playlist master (ou é uma playlist de mídia direta) — trata
    // como uma única "qualidade" apontando pra própria URL.
    return { variants: [{ url: baseUrl, bandwidth: 0, resolution: "", audioGroup: "" }], audioRenditions: [] };
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return { variants, audioRenditions };
}

async function fetchMasterVariants(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  return parseMasterVariants(text, url);
}

// ---------------------------------------------------------------------------
// Parser mínimo de manifesto DASH (.mpd), só para listar as representações de
// vídeo/áudio (resolução/bandwidth) na prévia. A resolução dos segmentos em
// si (SegmentTemplate/SegmentTimeline) fica no parser completo em
// downloader.js, que é quem efetivamente baixa.
// ---------------------------------------------------------------------------

function parseDashRepresentations(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("Manifesto DASH (.mpd) inválido.");

  const mpdEl = doc.documentElement;
  if (!mpdEl || mpdEl.tagName !== "MPD") throw new Error("O conteúdo não é um manifesto DASH válido.");

  const period = mpdEl.querySelector(":scope > Period");
  if (!period) throw new Error("Manifesto DASH sem nenhum <Period>.");

  const videoReps = [];
  const audioReps = [];

  period.querySelectorAll(":scope > AdaptationSet").forEach((as) => {
    const mimeType = as.getAttribute("mimeType") || "";
    const contentType =
      as.getAttribute("contentType") ||
      (mimeType.startsWith("video/") ? "video" : mimeType.startsWith("audio/") ? "audio" : "");
    if (contentType !== "video" && contentType !== "audio") return;

    const asHasDrm = as.querySelector(":scope > ContentProtection") !== null;

    as.querySelectorAll(":scope > Representation").forEach((repEl) => {
      const rep = {
        id: repEl.getAttribute("id") || "",
        bandwidth: parseInt(repEl.getAttribute("bandwidth") || "0", 10),
        width: repEl.getAttribute("width") || "",
        height: repEl.getAttribute("height") || "",
        drm: asHasDrm || repEl.querySelector(":scope > ContentProtection") !== null,
      };
      (contentType === "video" ? videoReps : audioReps).push(rep);
    });
  });

  videoReps.sort((a, b) => b.bandwidth - a.bandwidth);
  audioReps.sort((a, b) => b.bandwidth - a.bandwidth);
  return { videoReps, audioReps };
}

async function fetchDashRepresentations(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const text = await res.text();
  return parseDashRepresentations(text);
}

function labelForDashRep(rep) {
  const parts = [];
  if (rep.width && rep.height) parts.push(`${rep.width}x${rep.height}`);
  if (rep.bandwidth) parts.push(Math.round(rep.bandwidth / 1000) + " kbps");
  return (parts.join(" • ") || rep.id || "Original") + (rep.drm ? " 🔒" : "");
}

function pickAudioUrl(variant, audioRenditions) {
  if (!variant.audioGroup || !audioRenditions.length) return null;
  const group = audioRenditions.filter((a) => a.groupId === variant.audioGroup);
  if (!group.length) return null;
  const chosen = group.find((a) => a.isDefault) || group[0];
  return chosen.url;
}

function labelForVariant(variant) {
  const parts = [];
  if (variant.resolution) parts.push(variant.resolution);
  if (variant.bandwidth) parts.push(Math.round(variant.bandwidth / 1000) + " kbps");
  return parts.join(" • ") || "Original";
}

// ---------------------------------------------------------------------------
// Prévia (mini foto real) de cada vídeo
// ---------------------------------------------------------------------------
//
// Estratégia pensada especificamente pra não repetir o bug em feeds como o
// do X/Twitter, que "descobrem" dezenas de vídeos pré-carregados de uma vez:
//   1) NADA carrega automaticamente pra todos os itens ao renderizar a lista.
//      Um IntersectionObserver só dispara a geração da prévia quando o item
//      realmente aparece na área visível da lista (dentro do popup).
//   2) As prévias são geradas UMA DE CADA VEZ (fila global), nunca em
//      paralelo — mesmo rolando rápido, no máximo uma decodificação de vídeo
//      acontece por vez.
//   3) Cada geração é "tira uma foto e descarta": cria um <video> oculto (ou
//      usa o documento offscreen p/ HLS), captura um frame num <canvas> como
//      imagem estática e destrói o vídeo em seguida — não fica nada
//      reproduzindo/bufferizando depois de pronto.
//   4) Se falhar (URL expirada, CORS, timeout), mantém o ícone — sem travar
//      a lista.

function iconeParaTipo(kind) {
  if (kind === "dash") return "🧩";
  if (kind === "hls") return "📡";
  return "🎬";
}

function createPreviewIcon(video) {
  const span = document.createElement("span");
  span.className = "preview-icon";
  span.textContent = iconeParaTipo(video.kind);
  return span;
}

// Fila global: garante no máximo UMA geração de prévia em andamento por vez,
// não importa quantos itens fiquem visíveis ao mesmo tempo.
let filaPreview = Promise.resolve();
function enfileirarPreview(tarefa) {
  const resultado = filaPreview.then(tarefa, tarefa);
  filaPreview = resultado.catch(() => {});
  return resultado;
}

const THUMB_LOCAL_WIDTH = 160;
const THUMB_LOCAL_TIMEOUT_MS = 8000;

// Gera a prévia de um arquivo de vídeo direto localmente (sem passar pelo
// service worker): carrega só os metadados, busca um frame perto do início
// e captura pra um <canvas>. O elemento <video> é removido logo em seguida.
function gerarThumbArquivoLocal(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "metadata";
    v.playsInline = true;
    v.style.position = "fixed";
    v.style.width = "1px";
    v.style.height = "1px";
    v.style.opacity = "0";
    v.style.pointerEvents = "none";
    document.body.appendChild(v);

    let settled = false;
    const timer = setTimeout(() => finish(reject, new Error("Tempo esgotado.")), THUMB_LOCAL_TIMEOUT_MS);

    function finish(fn, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      v.remove();
      fn(val);
    }

    function captureFrame() {
      try {
        const w = THUMB_LOCAL_WIDTH;
        const h = Math.round((v.videoHeight / v.videoWidth) * w) || w;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(v, 0, 0, w, h);
        finish(resolve, canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) {
        finish(reject, e);
      }
    }

    v.addEventListener("loadeddata", () => {
      try {
        v.currentTime = Math.min(0.3, (v.duration || 1) / 10);
      } catch (e) {
        captureFrame();
      }
    });
    v.addEventListener("seeked", captureFrame);
    v.addEventListener("error", () => finish(reject, new Error("Erro ao carregar o vídeo.")));
    v.src = url;
  });
}

// Pede a prévia de um stream HLS ao service worker (que decodifica num
// documento offscreen, já com sua própria fila interna).
function gerarThumbHls(url, referer) {
  return chrome.runtime.sendMessage({ type: "GET_THUMBNAIL", url, referer: referer || "" }).then((res) => {
    if (!res || !res.ok) throw new Error((res && res.error) || "Sem prévia disponível.");
    return res.dataUrl;
  });
}

function carregarPreviewReal(video, tab, iconEl) {
  if (video.kind !== "file" && video.kind !== "hls") return; // DASH fica só com o ícone por ora

  enfileirarPreview(() => {
    const tarefa =
      video.kind === "hls"
        ? gerarThumbHls(video.url, tab.url)
        : chrome.runtime
            .sendMessage({ type: "SET_REFERER_RULE", referer: tab.url || "" })
            .catch(() => {})
            .then(() => gerarThumbArquivoLocal(video.url));
    return tarefa
      .then((dataUrl) => {
        if (!iconEl.isConnected) return; // item saiu da lista antes de terminar
        const img = document.createElement("img");
        img.className = "preview-thumb-img";
        img.alt = "";
        img.src = dataUrl;
        iconEl.replaceWith(img);
      })
      .catch(() => {
        // Sem prévia disponível — mantém o ícone mini.
      });
  });
}

// Um único IntersectionObserver compartilhado por toda a lista, recriado a
// cada render, observando o scroll dentro do <main> do popup. Cada item só
// dispara a geração de prévia (e sai da observação) quando entra na área
// visível — assim, itens fora da tela nunca consomem rede/CPU.
const previewScrollRoot = document.querySelector("main");
let previewObserver = null;

function novoPreviewObserver() {
  if (previewObserver) previewObserver.disconnect();
  previewObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        previewObserver.unobserve(entry.target);
        const ctx = entry.target._previewCtx;
        if (ctx) carregarPreviewReal(ctx.video, ctx.tab, ctx.iconEl);
      });
    },
    { root: previewScrollRoot, rootMargin: "60px 0px", threshold: 0.01 }
  );
  return previewObserver;
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function abrirDownloader(video, tab, { format, kind, srcUrl, bitrate, audio, rep, audioRep }) {
  const url =
    chrome.runtime.getURL("src/downloader.html") +
    `?src=${encodeURIComponent(srcUrl)}` +
    `&title=${encodeURIComponent(video.title || tab.title || "video")}` +
    `&referer=${encodeURIComponent(tab.url || "")}` +
    `&kind=${encodeURIComponent(kind)}` +
    `&format=${encodeURIComponent(format)}` +
    (bitrate ? `&bitrate=${encodeURIComponent(bitrate)}` : "") +
    (audio ? `&audio=${encodeURIComponent(audio)}` : "") +
    (rep ? `&rep=${encodeURIComponent(rep)}` : "") +
    (audioRep ? `&audioRep=${encodeURIComponent(audioRep)}` : "");
  chrome.tabs.create({ url });
}

// ---------------------------------------------------------------------------
// Monta as qualidades disponíveis para um vídeo + formato escolhidos
// ---------------------------------------------------------------------------

async function obterQualidades(video, formato, tab) {
  if (formato === "mp4") {
    if (video.kind === "file") {
      return [
        {
          label: "Original",
          onClick: () =>
            abrirDownloader(video, tab, {
              format: "mp4",
              kind: "file",
              srcUrl: video.url,
              // Alguns vídeos "arquivo direto" (Reels do Instagram, por
              // exemplo) chegam mudos, com o áudio numa faixa separada —
              // ver rememberAudioUrl em background.js. Quando detectada,
              // repassa pro downloader juntar as duas.
              audio: video.audioUrl || undefined,
            }),
        },
      ];
    }

    if (video.kind === "dash") {
      const { videoReps, audioReps } = await fetchDashRepresentations(video.url);
      if (!videoReps.length) throw new Error("Nenhuma representação de vídeo encontrada no manifesto DASH.");
      const audioRep = audioReps.find((a) => !a.drm) || null;
      return videoReps.map((rep) => ({
        label: labelForDashRep(rep),
        disabled: rep.drm,
        disabledReason: rep.drm ? "Protegido (DRM)" : undefined,
        onClick: () =>
          abrirDownloader(video, tab, {
            format: "mp4",
            kind: "dash",
            srcUrl: video.url,
            rep: rep.id,
            audioRep: audioRep ? audioRep.id : null,
          }),
      }));
    }

    const master = await fetchMasterVariants(video.url);
    return master.variants.map((variant) => ({
      label: labelForVariant(variant),
      onClick: () =>
        abrirDownloader(video, tab, {
          format: "mp4",
          kind: "hls",
          srcUrl: variant.url,
          audio: pickAudioUrl(variant, master.audioRenditions),
        }),
    }));
  }

  if (formato === "mp3") {
    return BITRATES_MP3.map((br) => ({
      label: `${br} kbps`,
      onClick: () =>
        abrirDownloader(video, tab, {
          format: "mp3",
          kind: video.kind,
          srcUrl: video.url,
          bitrate: br,
          // Ver o mesmo comentário no bloco "mp4" acima: sem isso, um
          // Reels mudo faz o decodeAudioData falhar por não haver áudio
          // nenhum no vídeo — foi exatamente esse o bug reportado aqui.
          audio: video.audioUrl || undefined,
        }),
    }));
  }

  // wav — sem perdas, uma única opção de qualidade.
  return [
    {
      label: "Qualidade original (PCM)",
      onClick: () =>
        abrirDownloader(video, tab, {
          format: "wav",
          kind: video.kind,
          srcUrl: video.url,
          audio: video.audioUrl || undefined,
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function criarLinhaQualidade(q) {
  const row = document.createElement("div");
  row.className = "quality-item";

  const label = document.createElement("span");
  label.className = "quality-label";
  label.textContent = q.label;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-primary";

  if (q.disabled) {
    btn.textContent = q.disabledReason || "Indisponível";
    btn.disabled = true;
  } else {
    btn.textContent = "Baixar";
    btn.addEventListener("click", () => {
      btn.disabled = true;
      btn.textContent = "Baixando…";
      Promise.resolve(q.onClick()).finally(() => {
        btn.disabled = false;
        btn.textContent = "Baixar";
      });
    });
  }

  row.appendChild(label);
  row.appendChild(btn);
  return row;
}

function createVideoItem(video, tab, index) {
  const li = document.createElement("li");
  li.className = "video-item";

  const preview = document.createElement("button");
  preview.type = "button";
  preview.className = "video-preview";
  const iconEl = createPreviewIcon(video);
  preview.appendChild(iconEl);

  const meta = document.createElement("div");
  meta.className = "video-meta";

  const name = document.createElement("span");
  name.className = "video-name";
  const displayTitle = (video.title || tab.title || "").trim();
  name.textContent = displayTitle
    ? displayTitle
    : video.kind === "hls"
      ? `Vídeo ${index + 1} (stream HLS)`
      : video.kind === "dash"
        ? `Vídeo ${index + 1} (stream DASH)`
        : `Vídeo ${index + 1} (.${extensionFromUrl(video.url)})`;
  name.title = video.url;

  const sub = document.createElement("span");
  sub.className = "video-sub";
  const size = formatSize(video.size);
  sub.textContent = size ? `${size} • ${video.source}` : video.source;

  meta.appendChild(name);
  meta.appendChild(sub);

  const chevron = document.createElement("span");
  chevron.className = "preview-chevron";
  chevron.textContent = "⌄";

  preview.appendChild(meta);
  preview.appendChild(chevron);

  const expandWrap = document.createElement("div");
  expandWrap.className = "expand-wrap";
  const expandInner = document.createElement("div");
  expandInner.className = "expand-inner";

  const formatRow = document.createElement("div");
  formatRow.className = "format-row";

  const qualityPanel = document.createElement("div");
  qualityPanel.className = "quality-panel hidden";

  let formatoAtual = null;
  const cacheQualidades = {};

  async function mostrarQualidades(formato) {
    qualityPanel.classList.remove("hidden");
    qualityPanel.innerHTML = "";

    if (cacheQualidades[formato]) {
      cacheQualidades[formato].forEach((q) => qualityPanel.appendChild(criarLinhaQualidade(q)));
      return;
    }

    const status = document.createElement("p");
    status.className = "quality-status";
    status.textContent = "Carregando qualidades…";
    qualityPanel.appendChild(status);

    try {
      const qualidades = await obterQualidades(video, formato, tab);
      if (formatoAtual !== formato) return; // trocou de formato enquanto carregava
      cacheQualidades[formato] = qualidades;
      qualityPanel.innerHTML = "";
      qualidades.forEach((q) => qualityPanel.appendChild(criarLinhaQualidade(q)));
    } catch (e) {
      if (formatoAtual !== formato) return;
      console.error("Falha ao carregar qualidades:", e);
      status.textContent = "Não foi possível carregar as qualidades aqui — abrindo aba de download…";
      status.classList.add("erro");
      abrirDownloader(video, tab, { format: formato === "mp4" ? "mp4" : formato, kind: video.kind, srcUrl: video.url });
    }
  }

  const formatoBtns = {};
  FORMATOS.forEach((formato) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "format-btn";
    b.textContent = formato.toUpperCase();
    b.addEventListener("click", () => {
      formatoAtual = formato;
      Object.entries(formatoBtns).forEach(([k, el]) => el.classList.toggle("ativo", k === formato));
      mostrarQualidades(formato);
    });
    formatRow.appendChild(b);
    formatoBtns[formato] = b;
  });

  expandInner.appendChild(formatRow);
  expandInner.appendChild(qualityPanel);
  expandWrap.appendChild(expandInner);

  preview.addEventListener("click", () => {
    const estavaAberto = li.classList.contains("aberto");
    if (itemAbertoEl && itemAbertoEl !== li) {
      itemAbertoEl.classList.remove("aberto");
    }
    li.classList.toggle("aberto", !estavaAberto);
    itemAbertoEl = !estavaAberto ? li : null;
  });

  li.appendChild(preview);
  li.appendChild(expandWrap);

  if (video.kind === "file" || video.kind === "hls") {
    li._previewCtx = { video, tab, iconEl };
    previewObserver.observe(li);
  }

  return li;
}

function renderVideos(videos, tab, restrictedPlatform) {
  listEl.innerHTML = "";
  itemAbertoEl = null;
  novoPreviewObserver();

  if (restrictedPlatform) {
    listEl.classList.add("hidden");
    emptyEl.classList.add("hidden");
    restrictedNomeEl.textContent = restrictedPlatform;
    restrictedEl.classList.remove("hidden");
    return;
  }
  restrictedEl.classList.add("hidden");
  listEl.classList.remove("hidden");

  if (!videos.length) {
    emptyEl.classList.remove("hidden");
    return;
  }
  emptyEl.classList.add("hidden");

  videos.forEach((video, index) => {
    listEl.appendChild(createVideoItem(video, tab, index));
  });
}

async function init() {
  const tab = await getActiveTab();
  if (!tab) return;

  const response = await chrome.runtime.sendMessage({
    type: "GET_VIDEOS",
    tabId: tab.id,
  });

  const videos = (response && response.videos) || [];
  renderVideos(videos, tab, response && response.restrictedPlatform);
}

async function atualizarLista() {
  const refreshBtn = document.getElementById("refresh-btn");
  refreshBtn.classList.add("girando");
  refreshBtn.disabled = true;

  const tab = await getActiveTab();
  if (!tab) {
    refreshBtn.classList.remove("girando");
    refreshBtn.disabled = false;
    return;
  }

  try {
    // Pede ao content script uma nova varredura da página — pega vídeos que
    // começaram a tocar depois da última varredura automática.
    await chrome.tabs.sendMessage(tab.id, { type: "RESCAN" });
  } catch (e) {
    // Página sem content script (ex.: chrome://, Web Store) — ignora e segue
    // só com o que o service worker já detectou via rede.
  }

  // Dá um instante para a varredura reportar ao service worker antes de ler.
  await new Promise((r) => setTimeout(r, 150));

  const response = await chrome.runtime.sendMessage({
    type: "GET_VIDEOS",
    tabId: tab.id,
  });
  const videos = (response && response.videos) || [];
  renderVideos(videos, tab, response && response.restrictedPlatform);

  refreshBtn.classList.remove("girando");
  refreshBtn.disabled = false;
}

// ---------------------------------------------------------------------------
// Tela de histórico + template de nome de arquivo
// ---------------------------------------------------------------------------

const viewListaEl = document.getElementById("view-lista");
const viewHistoricoEl = document.getElementById("view-historico");
const subtituloListaEl = document.getElementById("subtitulo-lista");
const subtituloHistoricoEl = document.getElementById("subtitulo-historico");
const footerTextoEl = document.getElementById("footer-texto");
const historyBtn = document.getElementById("history-btn");
const refreshBtnEl = document.getElementById("refresh-btn");
const templateInputEl = document.getElementById("template-input");
const templatePreviewEl = document.getElementById("template-preview");
const historyListEl = document.getElementById("history-list");
const historyEmptyEl = document.getElementById("history-empty");
const clearHistoryBtn = document.getElementById("clear-history-btn");

const TEMPLATE_PADRAO = "{titulo}";
const FOOTER_LISTA = "// clique no vídeo para escolher formato (MP4, MP3, WAV) e qualidade";
const FOOTER_HISTORICO = "// {titulo} {site} {data} {hora} {formato} — use no nome do arquivo";

function renderTemplatePreview(template) {
  const agora = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dados = {
    titulo: "video-exemplo",
    site: "site.com",
    data: `${agora.getFullYear()}-${pad2(agora.getMonth() + 1)}-${pad2(agora.getDate())}`,
    hora: `${pad2(agora.getHours())}${pad2(agora.getMinutes())}`,
    formato: "mp4",
  };
  const resultado = (template || TEMPLATE_PADRAO).replace(/\{(\w+)\}/g, (m, chave) =>
    Object.prototype.hasOwnProperty.call(dados, chave) ? dados[chave] : m
  );
  return sanitizeFilename(resultado) + ".mp4";
}

function formatHistoryDate(timestamp) {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderHistoryItem(entry) {
  const li = document.createElement("li");
  li.className = "history-item";

  const nome = document.createElement("span");
  nome.className = "history-nome";
  nome.textContent = entry.filename || "arquivo";

  const sub = document.createElement("span");
  sub.className = "history-sub";
  const partes = [entry.site, formatSize(entry.size), formatHistoryDate(entry.timestamp)].filter(Boolean);
  sub.textContent = partes.join(" • ");

  li.appendChild(nome);
  li.appendChild(sub);
  return li;
}

async function carregarHistorico() {
  const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
  historyListEl.innerHTML = "";
  if (!downloadHistory.length) {
    historyEmptyEl.classList.remove("hidden");
    historyListEl.classList.add("hidden");
    return;
  }
  historyEmptyEl.classList.add("hidden");
  historyListEl.classList.remove("hidden");
  downloadHistory.forEach((entry) => historyListEl.appendChild(renderHistoryItem(entry)));
}

async function carregarTemplate() {
  const { filenameTemplate = TEMPLATE_PADRAO } = await chrome.storage.local.get({
    filenameTemplate: TEMPLATE_PADRAO,
  });
  templateInputEl.value = filenameTemplate;
  templatePreviewEl.textContent = renderTemplatePreview(filenameTemplate);
}

let salvarTemplateTimeout = null;
templateInputEl.addEventListener("input", () => {
  const valor = templateInputEl.value;
  templatePreviewEl.textContent = renderTemplatePreview(valor);
  clearTimeout(salvarTemplateTimeout);
  // Pequeno debounce pra não gravar no storage a cada tecla digitada.
  salvarTemplateTimeout = setTimeout(() => {
    chrome.storage.local.set({ filenameTemplate: valor.trim() || TEMPLATE_PADRAO });
  }, 400);
});

clearHistoryBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_DOWNLOAD_HISTORY" });
  carregarHistorico();
});

function mostrarHistorico() {
  viewListaEl.classList.add("hidden");
  viewHistoricoEl.classList.remove("hidden");
  subtituloListaEl.classList.add("hidden");
  subtituloHistoricoEl.classList.remove("hidden");
  footerTextoEl.textContent = FOOTER_HISTORICO;
  historyBtn.classList.add("ativo");
  refreshBtnEl.classList.add("hidden");
  carregarHistorico();
  carregarTemplate();
}

function mostrarLista() {
  viewHistoricoEl.classList.add("hidden");
  viewListaEl.classList.remove("hidden");
  subtituloHistoricoEl.classList.add("hidden");
  subtituloListaEl.classList.remove("hidden");
  footerTextoEl.textContent = FOOTER_LISTA;
  historyBtn.classList.remove("ativo");
  refreshBtnEl.classList.remove("hidden");
}

historyBtn.addEventListener("click", () => {
  if (viewHistoricoEl.classList.contains("hidden")) mostrarHistorico();
  else mostrarLista();
});

document.getElementById("refresh-btn").addEventListener("click", atualizarLista);

init();
