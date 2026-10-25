/**
 * Most images one message carries. Discord allows 10 attachments, but its 10-image grid
 * crops the top of the last tile.
 */
export const MAX_GRID_IMAGES = 9;

/**
 * Grid sizes that crop an image: 7 lays out as one wide tile over two rows of three and cuts
 * off the top of the wide one, and 4 was asked to go the same way. Each is split into two
 * sizes that don't.
 */
const CROPPED_GRID_SPLITS = { 4: [2, 2], 7: [5, 2] };

/**
 * Split images (attachments, or anything standing in for them) into one batch per message:
 * full grids of MAX_GRID_IMAGES, then whatever is left — split again when that remainder is
 * a size that crops. Only the last batch can be one, since every other batch is full.
 * @template T
 * @param {T[]} items
 * @returns {T[][]} empty input → [].
 */
export function gridBatches(items) {
  const batches = [];
  for (let i = 0; i < items.length; i += MAX_GRID_IMAGES) batches.push(items.slice(i, i + MAX_GRID_IMAGES));

  const split = CROPPED_GRID_SPLITS[batches.at(-1)?.length];
  if (split) {
    const last = batches.pop();
    batches.push(last.slice(0, split[0]), last.slice(split[0]));
  }
  return batches;
}
