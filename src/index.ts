import { loadConfig } from "@config";
import { createAutoTraderWorkflow } from "@workflows/autoTrader";

const scheduleWithCron = (cadence: string, runner: () => Promise<void>) => {
  const bunCron = (Bun as any)?.Cron;
  if (typeof bunCron === "function") {
    new bunCron({
      cron: cadence,
      run: runner,
    });
    return true;
  }
  return false;
};

const scheduleWithInterval = (runner: () => Promise<void>) => {
  const fallbackMs = Number(process.env.TRADING_INTERVAL_MS ?? 60 * 60 * 1000);
  setInterval(() => {
    runner().catch((error) => console.error("Auto-trader run failed", error));
  }, fallbackMs);
};

const bootstrap = async () => {
  const config = loadConfig();
  const workflow = await createAutoTraderWorkflow();

  const runner = async () => {
    try {
      const result = await workflow.run();
      console.info(
        `Auto-trader executed ${result.executedOrders.length} orders at ${new Date().toISOString()}`,
      );
    } catch (error) {
      console.error("Auto-trader execution error", error);
    }
  };

  await runner();

  if (!scheduleWithCron(config.scheduler.cadence, runner)) {
    console.warn("Bun Cron unavailable; falling back to interval scheduling.");
    scheduleWithInterval(runner);
  }
};

bootstrap().catch((error) => {
  console.error("Failed to bootstrap auto-trader", error);
  process.exit(1);
});
