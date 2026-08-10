// Utilitários para extrair o áudio de um vídeo (Blob) e convertê-lo para
// MP3 ou WAV, inteiramente no navegador — sem enviar nada para servidores
// externos. Usa a Web Audio API para decodificar e o lamejs (biblioteca
// LAME, licença LGPL — ver src/vendor/LAME-LICENSE.txt) para codificar MP3.
//
// Requer que src/vendor/lame.min.js seja carregado antes deste arquivo
// (define o global `lamejs`) quando `formato === "mp3"`.

async function decodeAudioFromBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioContextCtor();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (e) {
    throw new Error(
      "Não foi possível decodificar o áudio deste vídeo (formato não suportado pelo navegador)."
    );
  } finally {
    ctx.close();
  }
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

// Gera um WAV PCM 16-bit a partir de um AudioBuffer (qualidade original,
// sem perdas — apenas o container muda).
function encodeWav(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const bitDepth = 16;

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(audioBuffer.getChannelData(ch));

  const length = channels[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAsciiString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiString(view, 8, "WAVE");
  writeAsciiString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAsciiString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function floatTo16BitPCM(input) {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

// Codifica um AudioBuffer em MP3 usando o lamejs (`window.lamejs`).
function encodeMp3(audioBuffer, bitrateKbps) {
  if (typeof lamejs === "undefined") {
    throw new Error("Codificador de MP3 não carregado.");
  }

  const numChannels = Math.min(audioBuffer.numberOfChannels, 2);
  const sampleRate = audioBuffer.sampleRate;
  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrateKbps);

  const left = floatTo16BitPCM(audioBuffer.getChannelData(0));
  const right = numChannels > 1 ? floatTo16BitPCM(audioBuffer.getChannelData(1)) : null;

  const blockSize = 1152;
  const chunks = [];

  for (let i = 0; i < left.length; i += blockSize) {
    const leftChunk = left.subarray(i, i + blockSize);
    const mp3buf = right
      ? encoder.encodeBuffer(leftChunk, right.subarray(i, i + blockSize))
      : encoder.encodeBuffer(leftChunk);
    if (mp3buf.length > 0) chunks.push(mp3buf);
  }

  const end = encoder.flush();
  if (end.length > 0) chunks.push(end);

  return new Blob(chunks, { type: "audio/mp3" });
}

// Ponto de entrada único: recebe o Blob de mídia já baixado e devolve o
// Blob final no formato pedido ("mp3" ou "wav").
async function extractAudio(blob, formato, bitrateKbps) {
  const audioBuffer = await decodeAudioFromBlob(blob);
  return formato === "mp3" ? encodeMp3(audioBuffer, bitrateKbps || 192) : encodeWav(audioBuffer);
}
