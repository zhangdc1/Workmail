export function normalizeMailLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value : null;
  } catch { return null; }
}

export function textMailLinks(text: string): string[] {
  return (text.match(/https?:\/\/[^\s<>"'\u0000-\u001f]+/gi) || []).map(value => {
    let link = value.replace(/[.,;!，。；！？”’）】]+$/u, "");
    while (link.endsWith(")") && (link.match(/\)/g)?.length || 0) > (link.match(/\(/g)?.length || 0)) link = link.slice(0, -1);
    return link;
  }).filter(value => normalizeMailLink(value) !== null);
}

export function collectMailLinks(text = "", html = "", extracted: string[] = []): string[] {
  const template = document.createElement("template");
  // Inert fragment: never inserted into the page, never executes mail content.
  template.innerHTML = html;
  const hrefs = Array.from(template.content.querySelectorAll("a[href]"), a => a.getAttribute("href") || "");
  return [...new Set([...extracted, ...hrefs, ...textMailLinks(text)].filter(value => normalizeMailLink(value) !== null))];
}
