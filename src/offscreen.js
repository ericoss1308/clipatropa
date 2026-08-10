// Roda dentro do documento offscreen (chrome.offscreen). Recebe pedidos de
// thumbnail do service worker, um de cada vez, e devolve um dataURL (JPEG
// pequeno) com o primeiro frame do vídeo — ou um erro.
//
// Fica isolado do popup de propósito: o popup pode fechar a qualquer
// momento (perda de foco, clique fora) e isso mataria qualquer trabalho
// assíncrono em andamento nele. O offscreen document sobrevive a isso.

const TIMEOUT_MS = 12000;
const THUMB_WIDTH = 320;

let queue = Promise.resolve();

function generateThumbnail(url) {
  return new Promise((resolve, reject) => {
    if (typeof Hls === "undefined") {
      reject(new Error("hls.js não está disponível (src/vendor/hls.min.js ausente)."));
      return;
    }

    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.style.position = "absolute";
    video.style.width = "1px";
    video.style.height = "1px";
    document.body.appendChild(video);

    let hls = null;
    let settled = false;
    const timer = setTimeout(() => {
      finish(reject, new Error("Tempo esgotado carregando o stream para a prévia."));
    }, TIMEOUT_MS);

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (hls) hls.destroy();
      } catch (e) {
        // ignora
      }
      video.remove();
      fn(value);
    }

    function captureFrame() {
      try {
        const w = THUMB_WIDTH;
        const h = Math.round((video.videoHeight / video.videoWidth) * w) || w;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(video, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        finish(resolve, dataUrl);
      } catch (e) {
        finish(reject, e);
      }
    }

    video.addEventListener("loadeddata", () => {
      // Pula um pouco pra frente pra evitar frames pretos/em branco iniciais.
      try {
        video.currentTime = Math.min(0.3, (video.duration || 1) / 10);
      } catch (e) {
        captureFrame();
      }
    });
    video.addEventListener("seeked", captureFrame);
    video.addEventListener("error", () => finish(reject, new Error("Erro ao carregar o vídeo para prévia.")));

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // Navegadores com suporte nativo a HLS (não é o caso do Chrome, mas
      // por garantia).
      video.src = url;
    } else if (Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 5 });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data && data.fatal) {
          finish(reject, new Error("hls.js: " + (data.details || data.type || "erro fatal")));
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      finish(reject, new Error("HLS não suportado neste navegador."));
      return;
    }
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "OFFSCREEN_GENERATE_THUMBNAIL") return false;

  queue = queue
    .then(() => generateThumbnail(message.url))
    .then(
      (dataUrl) => sendResponse({ ok: true, dataUrl }),
      (err) => sendResponse({ ok: false, error: (err && err.message) || String(err) })
    )
    .catch(() => {});

  return true; // resposta assíncrona
});
