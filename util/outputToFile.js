import fs from "fs/promises";
import path from "path";

/**
 * Write text content to a file (creating folders if needed).
 * @param {string} filename - Name or path of the file to write.
 * @param {string} content - The text content to save.
 * @param {object} [options]
 * @param {boolean} [options.timestamp=true] - If true, adds a timestamp before file extension.
 * @returns {Promise<string>} The final output file path.
 */
export async function outputToFile(filename, content, options = {}) {
  const { timestamp = true } = options;

  // create directory if necessary
  const dir = path.dirname(filename);
  await fs.mkdir(dir, { recursive: true });

  let outputPath = filename;

  if (timestamp) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    outputPath = path.join(dir, `${base}_${now}${ext}`);
  }

  await fs.writeFile(outputPath, content, "utf8");
  console.log(`[File] Saved to ${outputPath}`);
  return outputPath;
}
