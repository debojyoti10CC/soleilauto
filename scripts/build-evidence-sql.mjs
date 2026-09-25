import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.argv[2];
if (!directory)
  throw new Error(
    "Usage: node scripts/build-evidence-sql.mjs <soleil-docs-directory>",
  );
const baseUrl = (process.env.SOLEIL_DOCS_BASE_URL || "").replace(/\/$/, "");
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".mdx"))
  .sort();
if (!files.length) throw new Error("No .mdx pages found");
process.stdout.write(
  "-- Generated from Soleil docs. Review before running in Snowflake.\n",
);
for (const file of files) {
  const source = await readFile(join(directory, file), "utf8");
  const title =
    source.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ||
    file.replace(/\.mdx$/, "");
  const content = source
    .replace(/^---[\s\S]*?---\s*/, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 15_000);
  const slug = file === "index.mdx" ? "" : file.replace(/\.mdx$/, "");
  const url = baseUrl ? `${baseUrl}/${slug}` : "";
  process.stdout.write(
    `DELETE FROM SOLEIL_EVIDENCE WHERE ID = ${quote(file)};\n`,
  );
  process.stdout.write(
    `INSERT INTO SOLEIL_EVIDENCE (ID, TITLE, CONTENT, SOURCE_URL) VALUES (${quote(file)}, ${quote(title)}, ${quote(content)}, ${quote(url)});\n`,
  );
}
