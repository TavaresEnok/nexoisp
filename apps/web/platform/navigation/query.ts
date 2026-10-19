export type QueryValues = Record<string, string | null>;

export function readQueryValue<T extends string>(raw: string | null, fallback: T, allowed?: readonly T[]): T {
  return raw !== null && (!allowed || allowed.includes(raw as T)) ? raw as T : fallback;
}

export function updateQueryHref(href: string, values: QueryValues): string {
  const url = new URL(href, "https://navigation.invalid");
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === "") url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function linkedHref(pathname: string, values: QueryValues) {
  return updateQueryHref(pathname, values);
}
