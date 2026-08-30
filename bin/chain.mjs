/**
 * Cadeia de hash do log de patches (patches.jsonl) — trilha append-only do skill-state.
 *
 * Fórmula: `hash = sha256Hex(prev_hash + JSON.stringify(envelope))`, com genesis `"genesis"`.
 * SHA-256 via WebCrypto (`globalThis.crypto.subtle`) — funciona igual em Node ≥ 20 e no
 * navegador, garantindo que quem grava e quem confere usam a MESMA primitiva.
 *
 * Uma linha do patches.jsonl = { envelope, prev_hash, hash }. Consequências:
 * adulterar, remover ou reordenar uma linha quebra a cadeia no elo exato; a trilha inteira é
 * verificável offline, sem depender de quem a escreveu.
 */

export const GENESIS_HASH = "genesis";

export async function sha256Hex(payload) {
  const data = new TextEncoder().encode(payload);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fecha um envelope em elo da cadeia. */
export async function encadear(prevHash, envelope) {
  const hash = await sha256Hex(prevHash + JSON.stringify(envelope));
  return { envelope, prev_hash: prevHash, hash };
}

/**
 * Verifica a cadeia inteira. Devolve `{ok:true}` ou `{ok:false, quebradaEm}` (índice
 * 0-based da primeira linha cujo hash não fecha — elo adulterado, removido ou reordenado).
 */
export async function verificarCadeia(elos) {
  let anterior = GENESIS_HASH;
  for (let i = 0; i < elos.length; i += 1) {
    const elo = elos[i];
    if (elo.prev_hash !== anterior) return { ok: false, quebradaEm: i };
    const esperado = await sha256Hex(elo.prev_hash + JSON.stringify(elo.envelope));
    if (elo.hash !== esperado) return { ok: false, quebradaEm: i };
    anterior = elo.hash;
  }
  return { ok: true };
}
