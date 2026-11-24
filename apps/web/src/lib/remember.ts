/** Small view choices (which view, which panel is open) that outlive a page load. */
export const remember = <T extends string>(key: string, fallback: T): T => {
  try {
    return (window.localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
};

export const store = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: just don't remember */
  }
};
