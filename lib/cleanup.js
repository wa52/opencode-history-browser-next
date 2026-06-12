function createCleanupOnce(cleanup) {
  let pending;
  return () => {
    pending ??= Promise.resolve().then(cleanup);
    return pending;
  };
}

export { createCleanupOnce };
