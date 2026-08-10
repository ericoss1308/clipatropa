// Service worker: detecta vídeos por aba observando o tráfego de rede,
// mantém o estado em memória e expõe mensagens para o popup e content script.

const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "ogv", "mov", "m4v"];
const VIDEO_CONTENT_TYPES = ["video/mp4", "video/webm", "video/ogg", "video/quicktime", "video/x-m4v"];
const HLS_CONTENT_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl"];
// Quando um vídeo usa stream adaptativo com faixa de áudio separada, o
// player busca a playlist da FAIXA DE ÁUDIO à parte (pra tocar o áudio),
// numa requisição de rede própria — mesma extensão .m3u8 da playlist de
// vídeo, mas servida com um desses content-types. Sem distinguir isso, cada
// vídeo do feed do X virava DUAS entradas na lista: o vídeo de verdade e
// essa playlist de áudio, que aparecia como "mais um vídeo" (com prévia
// preta, porque não tem quadro nenhum pra capturar).
const AUDIO_ONLY_HLS_CONTENT_TYPES = ["audio/mpegurl", "audio/x-mpegurl"];
const DASH_CONTENT_TYPES = ["application/dash+xml"];

// Extensões/tipos de SEGMENTO de streams adaptativos (fMP4/CMAF/MPEG-TS) —
// nunca são um vídeo baixável sozinho, são só um pedacinho de alguns
// segundos de um stream HLS/DASH maior (o manifesto .m3u8/.mpd desse mesmo
// stream já é capturado à parte). O X entrega vídeo assim, e sem esse
// filtro cada segmento (às vezes só algumas dezenas de KB) era listado como
// se fosse um vídeo completo — daí os downloads "bugados" de poucos KB.
const SEGMENT_EXTENSIONS = ["m4s", "m4a", "cmfv", "cmfa", "ts"];
const SEGMENT_CONTENT_TYPES = ["video/iso.segment", "video/mp2t"];

// Além dos segmentos de mídia, streams fragmentados também mandam um
// segmento de INICIALIZAÇÃO (geralmente "init.mp4") antes dos segmentos de
// vídeo — só contém metadado (moov box), nenhum quadro de vídeo, e por isso
// pesa poucos KB (no X, ~1 KB). Como esse arquivo tem extensão .mp4 normal,
// o filtro de extensão acima não pega — por isso o corte por tamanho: nenhum
// vídeo de verdade pesa isso, então abaixo desse limiar é descartado.
const MIN_STANDALONE_FILE_BYTES = 40 * 1024; // 40 KB

// Plataformas cujos termos de uso proíbem explicitamente baixar o vídeo
// (streaming pago/licenciado, ou política própria contra downloads de
// terceiros). Nessas, a extensão nem coleta os vídeos — só avisa o motivo.
// "youtube.com" também cobre subdomínios como m.youtube.com e
// music.youtube.com (checado por sufixo abaixo).
const RESTRICTED_DOMAINS = {
  "youtube.com": "YouTube",
  "youtube-nocookie.com": "YouTube",
  "youtu.be": "YouTube",
  "netflix.com": "Netflix",
  "disneyplus.com": "Disney+",
  "primevideo.com": "Prime Video",
  "hbomax.com": "Max",
  "max.com": "Max",
  "hulu.com": "Hulu",
  "paramountplus.com": "Paramount+",
  "peacocktv.com": "Peacock",
  "tv.apple.com": "Apple TV+",
  "spotify.com": "Spotify",
  "twitch.tv": "Twitch",
  "crunchyroll.com": "Crunchyroll",
  "globoplay.globo.com": "Globoplay",
};

function restrictedPlatformForUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const domain in RESTRICTED_DOMAINS) {
      if (host === domain || host.endsWith("." + domain)) return RESTRICTED_DOMAINS[domain];
    }
  } catch (e) {
    // ignora — URL inválida (chrome://, etc.)
  }
  return null;
}

// Map<tabId, string|null> — nome da plataforma restrita da aba, ou null se
// não for uma delas. Atualizado a cada navegação (chrome.tabs.onUpdated) e
// consultado de forma síncrona no listener de rede, que dispara com muita
// frequência (uma chamada assíncrona por requisição seria cara demais).
const restrictedByTab = new Map();

function updateRestrictionForTab(tabId, url) {
  restrictedByTab.set(tabId, restrictedPlatformForUrl(url));
}

// Popula o estado pras abas já abertas quando o service worker inicia
// (ele pode reiniciar a qualquer momento no Manifest V3).
chrome.tabs.query({}, (tabs) => {
  tabs.forEach((tab) => {
    if (tab.id != null && tab.url) updateRestrictionForTab(tab.id, tab.url);
  });
});

// Map<tabId, Map<url, videoInfo>>
const videosByTab = new Map();

// Em feeds infinitos (X/Twitter, TikTok, Instagram...) o navegador pode
// pré-carregar dezenas de streams conforme o usuário rola a página, mesmo
// sem o vídeo ter sido reproduzido. Sem um limite, essa lista cresce sem
// parar e o popup fica lento pra renderizar. Mantemos só os mais recentes.
const MAX_VIDEOS_PER_TAB = 40;

function getTabMap(tabId) {
  let map = videosByTab.get(tabId);
  if (!map) {
    map = new Map();
    videosByTab.set(tabId, map);
  }
  return map;
}

function extensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const match = path.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : "";
  } catch (e) {
    return "";
  }
}

function looksLikeVideoUrl(url) {
  const ext = extensionFromUrl(url);
  return VIDEO_EXTENSIONS.includes(ext);
}

// Requisições em range (comuns em players de vídeo, ex.: "Range: bytes=0-1023"
// pra sondar o arquivo antes de decidir) respondem 206 com Content-Length do
// PEDAÇO pedido, não do arquivo inteiro — usar esse valor pra decidir
// "é pequeno demais, descarta" seria errado. O tamanho real do arquivo vem
// no Content-Range, no formato "bytes INÍCIO-FIM/TOTAL".
function parseContentRangeTotal(headers) {
  for (const h of headers) {
    if (h.name.toLowerCase() !== "content-range") continue;
    const m = /\/(\d+)\s*$/.exec(h.value || "");
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

async function isDomainBlacklisted(url) {
  try {
    const host = new URL(url).hostname;
    const { blacklist = [] } = await chrome.storage.local.get("blacklist");
    return blacklist.some((d) => host === d || host.endsWith("." + d));
  } catch (e) {
    return false;
  }
}

// O CDN do Instagram/Facebook (cdninstagram.com, fbcdn.net) entrega vídeo
// progressivo (não HLS/DASH) mas o PRÓPRIO player deles faz o buffering em
// pedaços, pedindo cada trecho como uma URL DIFERENTE — com o intervalo de
// bytes embutido na query string (?bytestart=X&byteend=Y), em vez do
// cabeçalho HTTP "Range" padrão. Cada pedaço chega como uma resposta 200
// comum (não 206/Content-Range), então nada nos filtros de segmento/
// tamanho acima reconhece isso: cada trecho vira, incorretamente, uma
// "entrada de vídeo" nova (tamanhos pequenos e variados, sem prévia, e
// corrompida se baixada — exatamente o bug relatado com os Reels).
//
// getByteRangeParams lê esses dois parâmetros quando presentes.
// stripByteRangeParams devolve a URL "limpa" (arquivo completo, do início
// ao fim) — usada tanto pra agrupar os pedaços numa única entrada quanto
// pra efetivamente baixar o vídeo inteiro (não só o trecho que o player
// buffereou primeiro).
function getByteRangeParams(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("bytestart") && !u.searchParams.has("byteend")) return null;
    const bytestart = parseInt(u.searchParams.get("bytestart") || "0", 10) || 0;
    const byteendRaw = u.searchParams.get("byteend");
    const byteend = byteendRaw != null ? parseInt(byteendRaw, 10) : null;
    return { bytestart, byteend };
  } catch (e) {
    return null;
  }
}

function stripByteRangeParams(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("bytestart");
    u.searchParams.delete("byteend");
    return u.toString();
  } catch (e) {
    return url;
  }
}

// O CDN do Instagram/Facebook não diferencia vídeo de áudio pelo
// Content-Type da resposta (ambos costumam vir como "video/mp4" genérico).
// A diferença fica escondida no parâmetro de query "efg": um JSON em
// base64 com um campo "vencode_tag" que termina em "_audio" quando é só a
// faixa de áudio (ex.: "...dash_ln_heaac_vbr3_audio" — "heaac" é o codec
// de áudio HE-AAC). Como o vídeo baixado como arquivo completo já traz o
// áudio embutido, essa faixa separada é redundante e não deve virar uma
// entrada própria na lista.
function isInstagramAudioTrackUrl(url) {
  try {
    const u = new URL(url);
    const efg = u.searchParams.get("efg");
    if (!efg) return false;
    const decoded = atob(efg);
    return /"vencode_tag"\s*:\s*"[^"]*audio[^"]*"/i.test(decoded);
  } catch (e) {
    return false;
  }
}

// Extrai "pasta" (origin + diretório) de uma URL — base tanto pra
// dedupeKeyFor (agrupar manifesto DASH/HLS do mesmo vídeo) quanto pra
// detectar arquivos-componente de um stream adaptativo (ver
// masterFoldersByTab logo abaixo).
function folderKeyForUrl(url) {
  try {
    const u = new URL(url);
    const dir = u.pathname.replace(/\/[^/]*$/, "/");
    return u.origin + dir;
  } catch (e) {
    return url;
  }
}

// Chave de deduplicação: ignora a query string. Muitos players (o do X
// incluso) reemitem a MESMA URL de manifesto (mesmo caminho) com um token/
// cache-buster diferente na query cada vez que o vídeo é recarregado (ex.:
// ao rolar, sair e voltar pro mesmo tweet) — sem isso, cada recarregamento
// virava uma entrada nova na lista, mesmo sendo o mesmo vídeo.
//
// O mesmo vale pra arquivos diretos: praticamente todo CDN de vídeo (o do
// Instagram/Facebook e o do TikTok confirmados na prática, mas o padrão é
// comum a qualquer CDN com link assinado) reemite a MESMA URL de vídeo com
// tokens de assinatura/expiração diferentes na query a cada recarregamento
// do mesmo post — sem ignorar a query aqui também, cada recarregamento
// virava uma entrada duplicada na lista. Em todo CDN desse tipo o caminho
// (pathname) já contém o identificador único do asset; a query carrega só
// autenticação/expiração, não a identidade do recurso.
//
// Agrupa pela PASTA, não pelo arquivo exato, no caso de HLS/DASH: vários
// CDNs (o do Reddit entre eles) publicam o manifesto DASH e o HLS do MESMO
// vídeo lado a lado na mesma pasta (ex.: .../<id>/DASHPlaylist.mpd e
// .../<id>/HLSPlaylist.m3u8) — sem agrupar por pasta, o mesmo vídeo virava
// duas entradas, uma por formato de manifesto. Pra arquivo direto não há
// esse cenário (é sempre um arquivo específico), então agrupa pelo
// caminho exato, não pela pasta.
function dedupeKeyFor(url, kind) {
  if (kind === "hls" || kind === "dash") return folderKeyForUrl(url);
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (e) {
    return url;
  }
}

// Sub-playlists internas de uma variante específica (ex.: caminho contendo
// "720x1280" ou "1080x1920") não são "outro vídeo" — são só uma resolução
// do mesmo stream, já listada pelo popup ao abrir o manifesto mestre. Sem
// filtrar, streams adaptativos (comum no X e em outros sites) apareciam
// como vários itens duplicados na lista, um por resolução.
const HLS_VARIANT_PATH_RE = /\/\d{2,5}x\d{2,5}\//;

function isLikelyHlsVariantSubPlaylist(url) {
  try {
    return HLS_VARIANT_PATH_RE.test(new URL(url).pathname);
  } catch (e) {
    return false;
  }
}

// Vários empacotadores DASH (o do Reddit/v.redd.it entre eles) servem cada
// qualidade — e a faixa de áudio — como um arquivo .mp4 individual, com um
// nome padronizado tipo "DASH_720.mp4", "DASH_360.mp4". A faixa de áudio em
// particular costuma vir como "DASH_AUDIO_128.mp4" (nem sempre só
// "DASH_audio.mp4") — o regex aceita qualquer sufixo depois de "DASH_" pra
// não depender de acertar o padrão exato de bitrate/nomenclatura que cada
// CDN usa. Cada um desses arquivos é só um COMPONENTE do vídeo adaptativo
// cujo manifesto (.mpd/.m3u8) já é capturado à parte — sem filtrar, cada
// qualidade (e a faixa de áudio, sozinha) virava uma entrada de "vídeo"
// própria: duplicação (uma por qualidade) e itens que eram só áudio (prévia
// preta, sem quadro nenhum pra capturar). Isso é só uma primeira camada
// rápida por nome; a checagem robusta de verdade é por PASTA, via
// masterFoldersByTab logo abaixo, que não depende de adivinhar nomenclatura.
const DASH_COMPONENT_FILENAME_RE = /^DASH_[A-Za-z0-9_]+\.mp4$/i;

function isDashComponentFile(url) {
  try {
    const path = new URL(url).pathname;
    const filename = path.slice(path.lastIndexOf("/") + 1);
    return DASH_COMPONENT_FILENAME_RE.test(filename);
  } catch (e) {
    return false;
  }
}

// Cache de classificação master/sub-playlist por URL — evita rebuscar a
// mesma playlist (players costumam repetir a mesma requisição ao rolar de
// volta pro mesmo vídeo).
const hlsMasterCache = new Map(); // url -> boolean
const HLS_MASTER_CACHE_MAX = 200;

// Só uma playlist MASTER (a que lista as variantes de qualidade, com
// #EXT-X-STREAM-INF) deve virar uma entrada de vídeo na lista. Qualquer
// outra .m3u8 é uma SUB-playlist buscada pelo player sozinho depois de ler o
// master: pode ser uma variante de vídeo específica, ou — o caso que
// causava o bug — a faixa de ÁUDIO separada, servida às vezes com
// content-type inconsistente (não sempre "audio/mpegurl"). Filtrar por
// content-type sozinho não é confiável; abrir a playlist e checar o
// conteúdo é o jeito robusto de saber se é master.
async function isHlsMasterPlaylist(url, tabId, initiator) {
  if (hlsMasterCache.has(url)) return hlsMasterCache.get(url);
  let isMaster = false;
  try {
    if (initiator) await setThumbnailReferer(initiator + "/");
    const res = await fetch(url, { credentials: "include" });
    if (res.ok) {
      const text = await res.text();
      isMaster = text.includes("#EXT-X-STREAM-INF");
    }
  } catch (e) {
    // Rede falhou (link expirado, etc.) — trata como "não é master" pra não
    // arriscar listar uma sub-playlist de áudio por engano.
  }
  hlsMasterCache.set(url, isMaster);
  if (hlsMasterCache.size > HLS_MASTER_CACHE_MAX) {
    hlsMasterCache.delete(hlsMasterCache.keys().next().value);
  }
  return isMaster;
}

// Segmentos de mídia fragmentada (CMAF, o formato usado por baixo dos panos
// pelo HLS/DASH em fMP4) começam com uma caixa ISOBMFF "styp" (Segment
// Type); só um arquivo completo ou um segmento de INICIALIZAÇÃO começa com
// "ftyp" (File Type). O Instagram entrega os vídeos de Reels/posts como uma
// sequência desses pedaços .mp4 — mas com content-type "video/mp4" comum e
// nome de arquivo comum, sem nenhum dos sinais que os filtros acima
// reconhecem (extensão de segmento, content-type de segmento, nome
// "DASH_*", pasta com manifesto conhecido). Cada pedaço acabava sendo
// listado como se fosse o vídeo inteiro: daí os itens sem prévia (um
// pedaço isolado não é um vídeo decodificável sozinho — falha ao carregar
// no <video> oculto que gera o thumbnail) e os downloads "corrompidos" (um
// .mp4 sem a caixa moov de um arquivo completo, então sem faixa de vídeo
// nem de áudio reconhecida por qualquer player). A checagem é feita lendo
// só os 12 primeiros bytes (Range request), não o arquivo inteiro.
const cmafSegmentCache = new Map(); // url -> boolean
const CMAF_SEGMENT_CACHE_MAX = 300;

// As checagens abaixo (isCmafMediaSegment e isHlsMasterPlaylist) fazem uma
// requisição PRÓPRIA da extensão pra espiar o conteúdo — diferente da
// requisição original do player, que sai com o Referer/Origin da página.
// CDNs que verificam esse cabeçalho (o do Instagram/Facebook entre eles)
// recusam (403) a requisição, que cai no catch e assume "não é segmento"/
// "não é master" pra não arriscar descartar um vídeo válido à toa — só que
// é exatamente esse fallback que deixava os pedaços do Instagram passarem
// como se fossem o vídeo inteiro (prévia com ícone de placeholder +
// download corrompido).
//
// IMPORTANTE: uma requisição feita de dentro do service worker (como o
// fetch() abaixo) NÃO é associada à aba real onde o vídeo está tocando —
// o Chrome trata como tabId -1, exatamente como as requisições do
// documento offscreen (ver setThumbnailReferer mais abaixo, definida com
// "tabIds: [-1]"). Por isso reaproveitamos aquela mesma regra de sessão em
// vez de criar uma nova escopada pra aba real (que nunca bateria com essas
// requisições).
async function isCmafMediaSegment(url, tabId, initiator) {
  if (cmafSegmentCache.has(url)) return cmafSegmentCache.get(url);
  let isSegment = false;
  try {
    if (initiator) await setThumbnailReferer(initiator + "/");
    const res = await fetch(url, { headers: { Range: "bytes=0-11" } });
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length >= 8) {
        const boxType = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
        isSegment = boxType === "styp";
      }
    }
  } catch (e) {
    // Sem CORS, link expirado, etc. — trata como "não é segmento" pra não
    // arriscar descartar um vídeo válido por causa de uma falha de rede.
  }
  cmafSegmentCache.set(url, isSegment);
  if (cmafSegmentCache.size > CMAF_SEGMENT_CACHE_MAX) {
    cmafSegmentCache.delete(cmafSegmentCache.keys().next().value);
  }
  return isSegment;
}

function updateBadge(tabId) {
  const map = videosByTab.get(tabId);
  const count = map ? map.size : 0;
  const text = count > 0 ? String(count) : "";
  chrome.action.setBadgeText({ tabId, text });
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#e11d48" });
}

// Map<tabId, Set<folderKey>> — pastas onde já vimos um manifesto DASH/HLS
// (a "fonte da verdade" pro vídeo adaptativo daquele post). Usado pra
// suprimir arquivos .mp4 diretos que são só um COMPONENTE desse mesmo
// stream (uma qualidade, ou a faixa de áudio) — em vez de tentar adivinhar
// pelo nome do arquivo (frágil: cada CDN nomeia diferente, e o Reddit já
// mudou esse padrão antes), a checagem é "essa pasta já tem um manifesto
// conhecido?", que funciona não importa a nomenclatura. Cobre tanto os
// arquivos vistos pelo listener de rede quanto os reportados pelo content
// script via DOM, já que ambos passam por addVideo.
const masterFoldersByTab = new Map();

function isKnownStreamComponentFolder(tabId, url) {
  const folders = masterFoldersByTab.get(tabId);
  if (!folders) return false;
  return folders.has(folderKeyForUrl(url));
}

// Quando um manifesto (dash/hls) é adicionado, registra a pasta como
// "master" e remove qualquer entrada "file" já na lista que more nessa
// mesma pasta — cobre o caso em que o componente (ex.: DASH_720.mp4) chegou
// primeiro, antes do manifesto ainda ter sido visto.
function markMasterFolderAndPurgeComponents(tabId, manifestUrl) {
  const folder = folderKeyForUrl(manifestUrl);
  let folders = masterFoldersByTab.get(tabId);
  if (!folders) {
    folders = new Set();
    masterFoldersByTab.set(tabId, folders);
  }
  folders.add(folder);

  const map = videosByTab.get(tabId);
  if (!map) return;
  let changed = false;
  for (const [key, video] of map) {
    if (video.kind === "file" && folderKeyForUrl(video.url) === folder) {
      map.delete(key);
      changed = true;
    }
  }
  if (changed) updateBadge(tabId);
}

async function addVideo(tabId, info) {
  if (tabId < 0 || !info.url) return;
  if (restrictedByTab.get(tabId)) return; // plataforma com download proibido — nem coleta
  if (info.kind === "hls" && isLikelyHlsVariantSubPlaylist(info.url)) return;
  if (info.kind === "file" && isKnownStreamComponentFolder(tabId, info.url)) return;
  if (await isDomainBlacklisted(info.url)) return;

  const map = getTabMap(tabId);
  const key = dedupeKeyFor(info.url, info.kind);
  const existing = map.get(key) || {};
  // Remove e reinsere pra mandar a entrada pro fim (Map preserva ordem de
  // inserção) — assim "mais recente" sempre fica por último. Guarda a URL
  // mais nova (o token da query pode ter expirado desde a última vez).
  map.delete(key);
  map.set(key, { ...existing, ...info });

  // Estoura o limite: descarta as entradas mais antigas primeiro.
  while (map.size > MAX_VIDEOS_PER_TAB) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }

  if (info.kind === "dash" || info.kind === "hls") {
    markMasterFolderAndPurgeComponents(tabId, info.url);
  }

  updateBadge(tabId);
}

// Detecção principal: inspeciona os headers da resposta (Content-Type / Content-Length).
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (restrictedByTab.get(details.tabId)) return; // plataforma com download proibido — nem processa

    const headers = details.responseHeaders || [];
    let contentType = "";
    let contentLength = 0;
    for (const h of headers) {
      const name = h.name.toLowerCase();
      if (name === "content-type") contentType = (h.value || "").split(";")[0].trim().toLowerCase();
      if (name === "content-length") contentLength = parseInt(h.value || "0", 10) || 0;
    }

    const ext = extensionFromUrl(details.url);
    const isSegment = SEGMENT_EXTENSIONS.includes(ext) || SEGMENT_CONTENT_TYPES.includes(contentType);
    const isAudioOnlyHls = AUDIO_ONLY_HLS_CONTENT_TYPES.includes(contentType);
    const isHls = !isAudioOnlyHls && (HLS_CONTENT_TYPES.includes(contentType) || ext === "m3u8");
    const isDash = DASH_CONTENT_TYPES.includes(contentType) || ext === "mpd";
    const isVideoType = VIDEO_CONTENT_TYPES.includes(contentType) || contentType.startsWith("video/");
    // Faixa de áudio separada de um arquivo "direto" (não playlist HLS/DASH)
    // — comum no Instagram, que busca o áudio como seu próprio .mp4/.m4a
    // (content-type "audio/..."), além do vídeo (que já traz áudio embutido
    // quando baixado como arquivo completo). Sem essa checagem, o
    // looksLikeVideoUrl abaixo aceitava pela extensão .mp4 mesmo sendo
    // áudio puro, e ela aparecia como uma segunda entrada solta na lista.
    const isAudioType = contentType.startsWith("audio/") || isInstagramAudioTrackUrl(details.url);

    // Ver getByteRangeParams: pedaço de vídeo progressivo do
    // Instagram/Facebook buffereado por bytestart/byteend na query string.
    // Só o pedaço que começa em bytestart=0 (o que carrega o cabeçalho do
    // arquivo, ftyp/moov) interessa — e mesmo esse só depois de trocado
    // pela URL sem os parâmetros de intervalo, pra baixar o arquivo
    // completo em vez de só o primeiro pedaço bufferizado.
    const byteRange = getByteRangeParams(details.url);
    if (byteRange && byteRange.bytestart > 0) return; // pedaço do meio/fim do arquivo — ignora
    const effectiveUrl = byteRange ? stripByteRangeParams(details.url) : details.url;

    // Tamanho real do arquivo: se for resposta parcial (206), usa o total do
    // Content-Range; senão, o Content-Length já é o arquivo inteiro.
    const rangeTotal = details.statusCode === 206 ? parseContentRangeTotal(headers) : null;
    const fileSize = rangeTotal != null ? rangeTotal : byteRange ? 0 : contentLength;
    // Só descarta por tamanho quando o tamanho é conhecido (>0) e pequeno
    // demais pra ser um vídeo de verdade (init segment, resposta de erro
    // disfarçada de vídeo, etc.). Tamanho desconhecido (0) passa normalmente.
    const isTooSmall = fileSize > 0 && fileSize < MIN_STANDALONE_FILE_BYTES;

    if (isHls) {
      const tabId = details.tabId;
      const url = details.url;
      isHlsMasterPlaylist(url, tabId, details.initiator).then((isMaster) => {
        if (!isMaster) return; // sub-playlist (vídeo específico ou faixa de áudio) — não lista sozinha
        addVideo(tabId, {
          url,
          contentType: "application/vnd.apple.mpegurl",
          size: 0,
          source: "network",
          kind: "hls",
        });
      });
    } else if (isDash) {
      addVideo(details.tabId, {
        url: details.url,
        contentType: "application/dash+xml",
        size: 0,
        source: "network",
        kind: "dash",
      });
    } else if (!isSegment && !isAudioType && !isTooSmall && !isDashComponentFile(details.url) && (isVideoType || looksLikeVideoUrl(details.url))) {
      const tabId = details.tabId;
      const url = effectiveUrl;
      const size = fileSize;
      const ct = contentType || "video/" + (ext || "mp4");
      // Um pedaço buffereado (mesmo o inicial, bytestart=0) ainda não é
      // garantidamente o arquivo inteiro — pula a checagem de assinatura
      // CMAF (styp/ftyp) pra ele, já que a URL efetiva (sem bytestart/
      // byteend) é outro recurso, que ainda não foi buscado; a checagem de
      // assinatura seria feita sobre a URL errada.
      const cmafCheck = byteRange ? Promise.resolve(false) : isCmafMediaSegment(url, tabId, details.initiator);
      cmafCheck.then((isCmaf) => {
        if (isCmaf) return; // pedaço de um stream fragmentado, não um vídeo completo
        addVideo(tabId, {
          url,
          contentType: ct,
          size,
          source: "network",
          kind: "file",
        });
      });
    }
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// Limpa o estado quando a aba navega para uma nova página ou é fechada.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    videosByTab.delete(tabId);
    masterFoldersByTab.delete(tabId);
    updateRestrictionForTab(tabId, changeInfo.url);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  videosByTab.delete(tabId);
  masterFoldersByTab.delete(tabId);
  restrictedByTab.delete(tabId);
});

// ---------------------------------------------------------------------------
// Histórico de downloads: guardado em chrome.storage.local (não em memória,
// pra sobreviver a reinícios do service worker e a fechar o navegador). O
// downloader.js manda uma mensagem RECORD_DOWNLOAD depois de cada
// chrome.downloads.download bem-sucedido; o popup lê via GET_DOWNLOAD_HISTORY.
// ---------------------------------------------------------------------------

const MAX_HISTORY_ITEMS = 200;

async function recordDownloadHistoryEntry(entry) {
  if (!entry || !entry.filename) return;
  const { downloadHistory = [] } = await chrome.storage.local.get("downloadHistory");
  downloadHistory.unshift(entry); // mais recente primeiro
  if (downloadHistory.length > MAX_HISTORY_ITEMS) downloadHistory.length = MAX_HISTORY_ITEMS;
  await chrome.storage.local.set({ downloadHistory });
}


// Mensagens do popup e do content script.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORD_DOWNLOAD") {
    recordDownloadHistoryEntry(message.entry);
    return false; // não precisa de resposta — best-effort, ver downloader.js
  }

  if (message.type === "CLEAR_DOWNLOAD_HISTORY") {
    chrome.storage.local.set({ downloadHistory: [] }).then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }

  if (message.type === "VIDEO_FOUND" && sender.tab) {
    // Vídeo detectado na DOM pelo content script. Alguns players (o do
    // Reddit incluso) colocam no <video src="..."> um arquivo de
    // COMPONENTE do stream adaptativo (ex.: "DASH_720.mp4",
    // "DASH_audio.mp4") como fallback antes de trocar pra reprodução via
    // blob/MSE — o manifesto (.mpd/.m3u8) desse mesmo vídeo já é capturado
    // à parte pelo listener de rede abaixo. Sem filtrar aqui também (o
    // listener de rede já filtra isso, mas essa mensagem não passa por
    // ele), cada vídeo assim virava DUAS entradas na lista assim que
    // aparecia na tela — exatamente o que rolar o feed do Reddit expõe,
    // já que o elemento <video> só é inserido no DOM quando o post entra
    // na área visível.
    if (message.kind === "file" && isDashComponentFile(message.url)) {
      sendResponse({ ok: true, skipped: true });
      return false;
    }
    addVideo(sender.tab.id, {
      url: message.url,
      contentType: message.contentType || "",
      size: 0,
      source: "dom",
      kind: message.kind || "file",
      title: message.title || "",
    });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "GET_VIDEOS") {
    const tabId = message.tabId;
    (async () => {
      let restricted = restrictedByTab.has(tabId) ? restrictedByTab.get(tabId) : null;
      if (!restrictedByTab.has(tabId)) {
        try {
          const tab = await chrome.tabs.get(tabId);
          restricted = restrictedPlatformForUrl(tab.url || "");
          restrictedByTab.set(tabId, restricted);
        } catch (e) {
          // aba pode já ter fechado — ignora
        }
      }
      const map = videosByTab.get(tabId);
      const videos = map ? Array.from(map.values()) : [];
      sendResponse({ videos, restrictedPlatform: restricted });
    })();
    return true; // resposta assíncrona
  }

  if (message.type === "GET_THUMBNAIL") {
    getThumbnail(message.url, message.referer).then(sendResponse);
    return true; // resposta assíncrona
  }

  if (message.type === "SET_REFERER_RULE") {
    // Usado pelo popup antes de carregar uma prévia local (kind "file"):
    // vários CDNs (TikTok incluso) só respondem com o Referer/Origin do
    // site original. Reaproveita a mesma regra de sessão (tabId -1) usada
    // pra prévia de HLS, já que requisições feitas pelo popup também caem
    // nesse tabId.
    setThumbnailReferer(message.referer).then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }

  return false;
});

// ---------------------------------------------------------------------------
// Prévia de streams HLS: gera um thumbnail decodificando o primeiro frame
// num documento offscreen (hls.js + <video> + <canvas>), já que um <video>
// comum não toca .m3u8 no Chrome. Resultado fica em cache por URL.
// ---------------------------------------------------------------------------

const THUMBNAIL_RULE_ID = 999999; // ID de regra reservado, não usado por setupHeaderRule (por-aba)
const thumbnailCache = new Map(); // url -> dataUrl
let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (existing.length > 0) return;
    await chrome.offscreen.createDocument({
      url: "src/offscreen.html",
      reasons: ["DOM_SCRAPING", "BLOBS"],
      justification: "Decodificar o primeiro frame de streams HLS (hls.js) para gerar uma prévia.",
    });
  })();

  return offscreenReady;
}

// Requisições feitas pelo documento offscreen não têm aba associada
// (tabId -1). Como muitos servidores de vídeo exigem Referer/Origin da
// página original, mantemos uma regra de sessão dedicada a esse tabId,
// atualizada com o referer de cada pedido antes de despachá-lo.
async function setThumbnailReferer(refererUrl) {
  if (!refererUrl || !chrome.declarativeNetRequest) return;
  let origin;
  try {
    origin = new URL(refererUrl).origin;
  } catch (e) {
    return;
  }
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [THUMBNAIL_RULE_ID],
    addRules: [
      {
        id: THUMBNAIL_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "Referer", operation: "set", value: refererUrl },
            { header: "Origin", operation: "set", value: origin },
          ],
        },
        condition: {
          tabIds: [-1],
          resourceTypes: ["xmlhttprequest", "media", "other"],
        },
      },
    ],
  });
}

async function getThumbnail(url, referer) {
  if (!url) return { ok: false, error: "URL ausente." };
  if (thumbnailCache.has(url)) return { ok: true, dataUrl: thumbnailCache.get(url) };

  try {
    await ensureOffscreenDocument();
    await setThumbnailReferer(referer);
    const result = await chrome.runtime.sendMessage({ type: "OFFSCREEN_GENERATE_THUMBNAIL", url });
    if (result && result.ok) thumbnailCache.set(url, result.dataUrl);
    return result || { ok: false, error: "Sem resposta do documento offscreen." };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
