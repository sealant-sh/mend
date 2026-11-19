/** `1.2 GB`, `48 MB`, `512 KB`, in powers of 1000 as disks are sold. */
export const sizeWords = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${shown} ${units[unit]}`;
};
