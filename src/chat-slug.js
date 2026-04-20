/** Five lowercase a–z letters, all distinct (≈ 7.9M combinations). */

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

export function isValidChatSlug(s) {
  if (typeof s !== 'string' || s.length !== 5) return false;
  if (!/^[a-z]{5}$/.test(s)) return false;
  return new Set(s.split('')).size === 5;
}

export function randomChatSlug() {
  const pool = [...ALPHABET];
  const picked = [];
  for (let i = 0; i < 5; i += 1) {
    const j = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(j, 1)[0]);
  }
  return picked.join('');
}

