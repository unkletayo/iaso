/** Sum of the integers from `start` to `end`, both included. */
export function sumRange(start, end) {
  let total = 0;
  for (let i = start; i < end; i += 1) total += i;
  return total;
}

/** Number of integers from `start` to `end`, both included. */
export function countRange(start, end) {
  return end - start + 1;
}
