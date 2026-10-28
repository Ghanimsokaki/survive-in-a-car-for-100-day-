export const BODY_COLORS = ['#ffb347', '#ff6b6b', '#5ff0ff', '#8bf5b4', '#c9a0ff', '#ffd166', '#f78fb3', '#e8ecf4', '#7f8ab0'];
export const CAR_COLORS = ['#d24a2b', '#2b6ad2', '#3aa06a', '#d2b02b', '#8a3ad2', '#38505e', '#c0c6d0', '#7a2b2b'];

export const hexToInt = (hex, fallback = 0xffb347) => {
  const v = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(v) ? v : fallback;
};
