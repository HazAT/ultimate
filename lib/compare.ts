export function compareUrl(repo: string, base: string, sha: string): string {
  return `https://diffshub.com/${repo.replace(/^github\.com\//, '')}/compare/${base}...${sha}`
}
