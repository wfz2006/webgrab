/**
 * 用共享游标在固定数量的 worker 间分配任务。每次领取新索引前检查取消信号，
 * 已经领取的任务由调用方决定是收尾还是响应 AbortError。
 */
export async function runBoundedConcurrent(total, concurrency, task, signal = null) {
  const taskCount = Math.max(0, Math.floor(Number(total) || 0));
  if (taskCount === 0) return;

  const workerCount = Math.min(
    taskCount,
    Math.max(1, Math.floor(Number(concurrency) || 1))
  );
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = nextIndex++;
      if (index >= taskCount) return;
      await task(index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}
