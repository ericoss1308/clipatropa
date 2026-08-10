# Clipatropa

Extensão para Google Chrome (Manifest V3) que detecta e baixa vídeos
reproduzidos em páginas da web:

- **Arquivos diretos** (`.mp4`, `.webm`, `.ogg`, `.mov`, etc.) — download
  imediato.
- **Streams HLS** (`.m3u8`) — o formato de streaming usado pela maioria dos
  sites. A extensão baixa todos os segmentos, descriptografa AES-128 padrão
  quando presente e junta tudo em um único arquivo, com escolha de qualidade
  e barra de progresso.
- **Streams DASH** (`.mpd`) — baixa as representações descritas via
  `SegmentTemplate` (com `SegmentTimeline` ou `@duration` fixa, que é o caso
  mais comum em CMAF/fMP4), com escolha de qualidade e o mesmo mux
  automático de vídeo+áudio usado no HLS (ver abaixo).

## Como funciona

- Um **service worker** observa o tráfego de rede da aba e captura URLs de
  mídia (por `Content-Type` ou pela extensão do arquivo), incluindo
  manifestos HLS (`.m3u8`) e DASH (`.mpd`).
- Um **content script** varre a página em busca de tags `<video>`/`<source>`.
- O **popup** (ícone da extensão) lista os vídeos detectados na aba atual,
  cada um com uma prévia. Para arquivos diretos a prévia é o próprio
  `<video>`; para streams HLS (ex.: X/Twitter) o popup pede ao service
  worker um thumbnail, que é gerado num **documento offscreen** com
  [hls.js](https://github.com/video-dev/hls.js) decodificando o primeiro
  frame — um `<video>` comum não toca `.m3u8` no Chrome. Clicar na prévia
  expande um painel com os formatos disponíveis — **MP4**, **MP3**, **WAV**
  — e clicar em um formato lista as qualidades correspondentes (resoluções
  para MP4, bitrates para MP3, PCM original para WAV).
- Baixar um MP4 de arquivo direto na qualidade "Original" é imediato; todo
  o resto (escolha de variante HLS/representação DASH e qualquer extração
  de áudio) abre `src/downloader.html`, que baixa a mídia, mostra o
  progresso e — para MP3/WAV — decodifica o áudio com a Web Audio API e
  recodifica com [lamejs](https://github.com/zhuker/lamejs) (MP3) ou um
  encoder WAV próprio, tudo no navegador, sem enviar nada para servidores
  externos.
- O número no **badge** do ícone mostra quantos vídeos foram detectados.

## Instalar em modo desenvolvedor

1. Abra `chrome://extensions` no Chrome.
2. Ative o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione esta pasta.
4. O ícone da extensão aparece na barra de ferramentas.

## Testar

1. Abra uma página com um vídeo de arquivo direto (ex.: um `<video>` `.mp4`
   público de teste).
2. Reproduza o vídeo. O badge deve mostrar a contagem.
3. Clique no ícone da extensão e use **Baixar**.

## Extração de áudio (MP3/WAV)

- Funciona para arquivos diretos e para streams HLS (nesse caso, prioriza a
  faixa de áudio separada quando o stream tem uma, ou a variante de menor
  bitrate quando não tem — assim baixa menos dado que precisar do vídeo
  inteiro).
- A decodificação usa `AudioContext.decodeAudioData`, que depende dos
  codecs que o próprio Chrome sabe decodificar. Streams HLS antigos em
  `.ts` (MPEG-TS) podem falhar na decodificação; streams em fMP4 (CMAF) e
  arquivos `.mp4`/`.webm` funcionam bem.
- O WAV é sempre PCM 16-bit sem perdas (só o container muda); o MP3 permite
  escolher 128/192/320 kbps.
- A biblioteca MP3 (`src/vendor/lame.min.js`, projeto lamejs/LAME) é
  licenciada em LGPL — ver `src/vendor/LAME-LICENSE.txt`.

## Limitações

- **DRM**: streams protegidos (Widevine, FairPlay, PlayReady, SAMPLE-AES) são
  detectados e **recusados** — a extensão não contorna proteção de conteúdo.
  Apenas a criptografia de transporte AES-128 padrão do HLS é suportada.
- **HLS com áudio separado** (comum em fMP4, ex.: X/Twitter): a extensão
  tenta juntar vídeo e áudio automaticamente num único `.mp4`, sem
  recodificar (`src/mp4-mux.js`, remuxer ISOBMFF próprio, sem dependências).
  Se o stream não se encaixar no caso suportado (não é fMP4, ou usa
  `base-data-offset` absoluto no `tfhd`), cai de volta para o comportamento
  antigo: dois arquivos separados + aviso para juntar com FFmpeg. **Esse
  remuxer é novo e não foi testado contra um stream real do X/Twitter** —
  teste e reporte se o `.mp4` gerado não abrir corretamente.
- **HLS em TS**: o resultado é um `.ts` (abre no VLC); converter para `.mp4`
  exige FFmpeg. O mux automático acima só vale para fMP4, não para TS.
- **DASH (`.mpd`)**: só representações descritas via `SegmentTemplate`
  (`SegmentTimeline` ou `@duration` fixa) são suportadas — é o caso mais
  comum em CMAF/fMP4, mas manifestos que usam `SegmentBase`/`SegmentList`
  (um único arquivo com byte-ranges) são detectados e recusados com um erro
  claro, sem download parcial. `ContentProtection` (Widevine/PlayReady/
  qualquer DRM) é detectado e recusado, como no HLS. Streams dinâmicos
  (`type="dynamic"`, ao vivo) sem `SegmentTimeline` e sem duração conhecida
  também falham, pelo mesmo motivo. Não há prévia (thumbnail) para DASH no
  popup — fica só o ícone de placeholder.
- Transmissões **ao vivo**: baixa apenas o trecho disponível no momento.
- O vídeo é montado em memória antes de salvar — vídeos muito longos
  (vários GB) podem falhar.
- Não baixa `blob:` nem `data:` URIs diretamente (mas o stream HLS por trás
  deles é detectado pela rede).

## Estrutura

```
manifest.json              Configuração da extensão (MV3)
src/background.js          Service worker: detecção via webRequest + badge + thumbnails HLS
src/content.js             Varredura de <video>/<source> na DOM
src/offscreen.html/js      Documento offscreen: decodifica frame HLS com hls.js p/ prévia
src/popup.html/css/js      UI do popup: prévia + formato (MP4/MP3/WAV) + qualidade
src/downloader.html/css/js Página de download: qualidade HLS/DASH, progresso, mux e extração de áudio
src/audio-convert.js       Decodificação (Web Audio) e codificação (WAV/MP3) de áudio
src/mp4-mux.js             Remuxer fMP4 próprio (junta vídeo+áudio HLS separados sem recodificar)
src/vendor/lame.min.js     Encoder MP3 (lamejs/LAME, LGPL)
src/vendor/hls.min.js      Player HLS p/ gerar prévia (video-dev/hls.js, Apache-2.0) — **precisa ser
                            baixado manualmente**, ver "Instalar em modo desenvolvedor"
icons/                     Ícones (16/48/128)
```

## ⚠️ Passo obrigatório: baixar o hls.js

Por limitação do ambiente em que este código foi gerado, não foi possível
baixar o arquivo binário da biblioteca hls.js automaticamente. Antes de
carregar a extensão:

1. Baixe `https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js`.
2. Salve como `src/vendor/hls.min.js` (mesma pasta do `lame.min.js`).

Sem esse arquivo, o resto da extensão funciona normalmente — só a prévia de
streams HLS continua mostrando o ícone de placeholder em vez do thumbnail.
