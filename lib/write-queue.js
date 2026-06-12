function createWriteQueue(write) {
  let pending = Promise.resolve();
  return {
    enqueue(value) {
      const snapshot = structuredClone(value);
      const result = pending.catch(() => {}).then(() => write(snapshot));
      pending = result.catch(() => {});
      return result;
    },
    flush() {
      return pending;
    },
  };
}

export { createWriteQueue };
