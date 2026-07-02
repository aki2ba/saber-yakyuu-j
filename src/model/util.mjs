// モデル共通の小ヘルパー（ブラウザ安全・依存ゼロ）。
// バンドル後は全モジュールが同一スコープに並ぶため、共有ヘルパーはここ一箇所に定義する。

/** 値を [min,max] に丸める */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** 能力のスカウティングスケール（20=最低, 50=リーグ平均, 80=最高）に丸める */
export function clampRating(v) {
  return clamp(Math.round(v), 20, 80);
}

/** src の数値プロパティを dst に加算（両者フラットな数値マップ前提の集計ヘルパー） */
export function addNumeric(dst, src) {
  for (const k of Object.keys(src)) {
    if (typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k];
  }
  return dst;
}
