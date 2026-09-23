/** Initiales d'un nom ou d'un identifiant, pour les avatars (« Julie Martin » → « JM »). */
export function initialsOf(name: string | null | undefined): string {
  const value = (name ?? '').trim();
  if (value === '') return '•';
  const words = value.split(/[\s._-]+/).filter((word) => word !== '');
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : value.slice(0, 2);
  return letters.toUpperCase();
}
