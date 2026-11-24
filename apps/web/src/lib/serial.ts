/**
 * A queue that runs async jobs one after the other, in the order they came. The terminal sends its
 * keys through one, so 2 POSTs in flight cannot reach the shell out of order.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return (job: () => Promise<unknown>): Promise<void> => {
    const next = tail.then(job, job).then(
      () => undefined,
      () => undefined,
    );
    tail = next;
    return next;
  };
}
