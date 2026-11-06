const MAX_IMAGE_URL_LENGTH = 1_500_000;

export function isAllowedImageUrl(value: string): boolean {
  if (value.length > MAX_IMAGE_URL_LENGTH) return false;
  if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]*={0,2}$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
