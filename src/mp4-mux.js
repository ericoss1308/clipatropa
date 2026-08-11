// Muxer fMP4/CMAF minimalista, sem dependências externas.
//
// Junta uma trilha de vídeo e uma trilha de áudio — cada uma baixada como
// segmentos HLS fragmentados (init "ftyp+moov" seguido de fragmentos
// "moof+mdat") — em um único arquivo MP4 com as duas trilhas, sem
// recodificar nada: só reescreve os campos de track_ID/sequence_number
// necessários para as duas trilhas conviverem no mesmo arquivo.
//
// Não funciona para streams em MPEG-TS (segmentos .ts) nem para tfhd com
// "base-data-offset" absoluto (bit 0x000001) — nesses casos lança um erro e
// quem chamar deve cair de volta para o fluxo antigo (dois arquivos + aviso
// para juntar com FFmpeg).

function readFourCC(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// Percorre os boxes ISOBMFF no intervalo [start, end) de `bytes` (irmãos no
// mesmo nível, não desce em containers).
function* iterateBoxes(bytes, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + pos, 8);
    let size = view.getUint32(0);
    const type = readFourCC(bytes, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      const view2 = new DataView(bytes.buffer, bytes.byteOffset + pos + 8, 8);
      const hi = view2.getUint32(0);
      const lo = view2.getUint32(4);
      size = hi * 4294967296 + lo;
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) break;
    yield { type, start: pos, headerSize, bodyStart: pos + headerSize, end: pos + size };
    pos += size;
  }
}

function findBox(bytes, start, end, type) {
  for (const box of iterateBoxes(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function mustFindBox(bytes, start, end, type, context) {
  const box = findBox(bytes, start, end, type);
  if (!box) throw new Error(`Box "${type}" não encontrado (${context}) — formato inesperado.`);
  return box;
}

function setU32(bytes, absoluteOffset, value) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(absoluteOffset, value);
}

function readU24(bytes, absoluteOffset) {
  return (bytes[absoluteOffset] << 16) | (bytes[absoluteOffset + 1] << 8) | bytes[absoluteOffset + 2];
}

// --- Patches em campos específicos de full boxes ---------------------------

function setTkhdTrackId(trakBytes, tkhdBox, id) {
  const version = trakBytes[tkhdBox.bodyStart];
  const offset = tkhdBox.bodyStart + 4 + (version === 1 ? 16 : 8);
  setU32(trakBytes, offset, id);
}

function setMvhdNextTrackId(mvhdBytes, mvhdBox, id) {
  const version = mvhdBytes[mvhdBox.bodyStart];
  const timesLen = version === 1 ? 28 : 16; // creation+modification+timescale+duration
  const offset = mvhdBox.bodyStart + 4 + timesLen + 16 /* rate/volume/reserved */ + 36 /* matrix */ + 24; /* pre_defined */
  setU32(mvhdBytes, offset, id);
}

function setTrexTrackId(trexBytes, trexBox, id) {
  setU32(trexBytes, trexBox.bodyStart + 4, id);
}

function setMfhdSeq(moofBytes, mfhdBox, seq) {
  setU32(moofBytes, mfhdBox.bodyStart + 4, seq);
}

function setTfhdTrackId(moofBytes, tfhdBox, id) {
  const flags = readU24(moofBytes, tfhdBox.bodyStart + 1);
  if (flags & 0x000001) {
    // base-data-offset-present: o offset é absoluto no arquivo original e
    // ficaria errado no arquivo remontado. Não suportado — quem chamar cai
    // para o fluxo de dois arquivos.
    throw new Error("Stream usa base-data-offset absoluto no tfhd; remux automático não suportado.");
  }
  setU32(moofBytes, tfhdBox.bodyStart + 4, id);
}

// --- Montagem de boxes -------------------------------------------------

function wrapBox(type, bodyBytes) {
  const size = 8 + bodyBytes.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(bodyBytes, 8);
  return out;
}

function concatBytes(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// Extrai o trex de dentro de um mvex (do init original) já com o track_ID
// forçado para o valor desejado.
function extractTrexForceId(initBytes, mvexBox, forcedId, context) {
  const trex = mustFindBox(initBytes, mvexBox.bodyStart, mvexBox.end, "trex", context);
  const trexBytes = initBytes.slice(trex.start, trex.end);
  setTrexTrackId(trexBytes, { bodyStart: trex.headerSize }, forcedId);
  return trexBytes;
}

// Processa um fragmento (moof+mdat, possivelmente precedido de styp/sidx que
// são descartados) forçando o track_ID no tfhd e numerando o mfhd.
function processFragment(fragBuffer, trackId, seqRef) {
  const bytes = new Uint8Array(fragBuffer).slice();
  const out = [];

  for (const box of iterateBoxes(bytes, 0, bytes.length)) {
    if (box.type === "moof") {
      const moofBytes = bytes.slice(box.start, box.end);
      const mfhd = findBox(moofBytes, 8, moofBytes.length, "mfhd");
      if (mfhd) setMfhdSeq(moofBytes, mfhd, seqRef.value++);

      for (const child of iterateBoxes(moofBytes, 8, moofBytes.length)) {
        if (child.type !== "traf") continue;
        const tfhd = findBox(moofBytes, child.bodyStart, child.end, "tfhd");
        if (tfhd) setTfhdTrackId(moofBytes, tfhd, trackId);
      }
      out.push(moofBytes);
    } else if (box.type === "mdat") {
      out.push(bytes.slice(box.start, box.end));
    }
    // styp, sidx, prft, free, etc. — descartados, não são necessários para
    // reprodução de um arquivo local já completo.
  }

  return out;
}

/**
 * Junta uma trilha de vídeo e uma de áudio HLS fMP4/CMAF em um único MP4.
 *
 * @param {object} params
 * @param {ArrayBuffer} params.videoInit  init segment do vídeo (ftyp+moov)
 * @param {ArrayBuffer[]} params.videoFrags  fragmentos do vídeo (moof+mdat), em ordem
 * @param {ArrayBuffer} params.audioInit  init segment do áudio (ftyp+moov)
 * @param {ArrayBuffer[]} params.audioFrags  fragmentos do áudio (moof+mdat), em ordem
 * @returns {Blob} arquivo MP4 combinado, pronto para download
 */
function muxFmp4({ videoInit, videoFrags, audioInit, audioFrags }) {
  const vInit = new Uint8Array(videoInit);
  const aInit = new Uint8Array(audioInit);

  const ftypBox = mustFindBox(vInit, 0, vInit.length, "ftyp", "init de vídeo");
  const ftypBytes = vInit.slice(ftypBox.start, ftypBox.end);

  const vMoov = mustFindBox(vInit, 0, vInit.length, "moov", "init de vídeo");
  const aMoov = mustFindBox(aInit, 0, aInit.length, "moov", "init de áudio");

  const vMvhd = mustFindBox(vInit, vMoov.bodyStart, vMoov.end, "mvhd", "moov de vídeo");
  const vTrak = mustFindBox(vInit, vMoov.bodyStart, vMoov.end, "trak", "moov de vídeo");
  const vMvex = mustFindBox(vInit, vMoov.bodyStart, vMoov.end, "mvex", "moov de vídeo");
  const aTrak = mustFindBox(aInit, aMoov.bodyStart, aMoov.end, "trak", "moov de áudio");
  const aMvex = mustFindBox(aInit, aMoov.bodyStart, aMoov.end, "mvex", "moov de áudio");

  const mvhdBytes = vInit.slice(vMvhd.start, vMvhd.end);
  setMvhdNextTrackId(mvhdBytes, { bodyStart: vMvhd.headerSize }, 3);

  const vTrakBytes = vInit.slice(vTrak.start, vTrak.end);
  setTkhdTrackId(vTrakBytes, mustFindBox(vTrakBytes, vTrak.headerSize, vTrakBytes.length, "tkhd", "trak de vídeo"), 1);

  const aTrakBytes = aInit.slice(aTrak.start, aTrak.end);
  setTkhdTrackId(aTrakBytes, mustFindBox(aTrakBytes, aTrak.headerSize, aTrakBytes.length, "tkhd", "trak de áudio"), 2);

  const vTrexBytes = extractTrexForceId(vInit, vMvex, 1, "mvex de vídeo");
  const aTrexBytes = extractTrexForceId(aInit, aMvex, 2, "mvex de áudio");

  const mvexBytes = wrapBox("mvex", concatBytes([vTrexBytes, aTrexBytes]));
  const moovBytes = wrapBox("moov", concatBytes([mvhdBytes, vTrakBytes, aTrakBytes, mvexBytes]));

  const seqRef = { value: 1 };
  const parts = [ftypBytes, moovBytes];
  for (const frag of videoFrags) parts.push(...processFragment(frag, 1, seqRef));
  for (const frag of audioFrags) parts.push(...processFragment(frag, 2, seqRef));

  return new Blob(parts, { type: "video/mp4" });
}

// Detecta se um init segment parece ser fMP4 válido (começa com ftyp).
function looksLikeFmp4(buffer) {
  if (!buffer || buffer.byteLength < 8) return false;
  const bytes = new Uint8Array(buffer, 0, 8);
  return readFourCC(bytes, 4) === "ftyp";
}

// Divide um arquivo MP4 COMPLETO (já baixado inteiro, não por playlist HLS)
// em "init" (tudo antes do primeiro moof — ftyp+moov) e "fragmentos"
// (cada trecho começando em um moof, até o próximo moof ou o fim do
// arquivo) — no mesmo formato que muxFmp4 espera.
//
// Existe pra reaproveitar o mux acima em vídeos "arquivo direto" baixados
// inteiros de uma vez (ex.: Reels do Instagram, que na prática usa o mesmo
// empacotamento fragmentado CMAF por baixo, mesmo entregando um MP4
// "completo" via range request em vez de uma playlist HLS). Lança erro se
// não encontrar nenhum "moof" — nesse caso o arquivo é um MP4 clássico
// (não fragmentado), que não é suportado por este mux; quem chamar deve
// cair de volta para o fluxo de dois arquivos separados.
function splitCompleteFmp4(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const topBoxes = [...iterateBoxes(bytes, 0, bytes.length)];

  const firstMoofIndex = topBoxes.findIndex((b) => b.type === "moof");
  if (firstMoofIndex === -1) {
    throw new Error(
      "Arquivo não é fMP4 fragmentado (nenhum box 'moof' encontrado) — remux automático não se aplica."
    );
  }

  const initEnd = topBoxes[firstMoofIndex].start;
  const initBuffer = bytes.slice(0, initEnd).buffer;

  const fragBuffers = [];
  for (let i = firstMoofIndex; i < topBoxes.length; i++) {
    if (topBoxes[i].type !== "moof") continue;
    const start = topBoxes[i].start;
    let end = bytes.length;
    for (let j = i + 1; j < topBoxes.length; j++) {
      if (topBoxes[j].type === "moof") {
        end = topBoxes[j].start;
        break;
      }
    }
    fragBuffers.push(bytes.slice(start, end).buffer);
  }

  return { initBuffer, fragBuffers };
}
