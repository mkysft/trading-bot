import { promises as fs } from "fs";
import path from "path";
import { loadConfig } from "@config";
import { IBKRClient, TradeOrder } from "@ibkr/client";
import { VolatilityScanner } from "@analysis/volatilityScanner";
import { StrategyEngine, StrategyProposal } from "@analysis/strategy";
import { IncomingWebhook } from "@slack/webhook";
import nodemailer from "nodemailer";

export interface AutoTraderResult {
  proposals: StrategyProposal[];
  executedOrders: Array<{ symbol: string; orderId: number; estimatedCost: number }>;
}

class NotificationDispatcher {
  private slack?: IncomingWebhook;
  private emailTransporter?: nodemailer.Transporter;

  constructor() {
    const config = loadConfig();

    if (config.notifications.slackWebhookUrl) {
      this.slack = new IncomingWebhook(config.notifications.slackWebhookUrl);
    }

    if (config.notifications.email) {
      this.emailTransporter = nodemailer.createTransport({
        host: config.notifications.email.smtpHost,
        port: config.notifications.email.smtpPort,
        secure: config.notifications.email.smtpPort === 465,
        auth:
          config.notifications.email.user && config.notifications.email.password
            ? {
                user: config.notifications.email.user,
                pass: config.notifications.email.password,
              }
            : undefined,
      });
    }
  }

  async send(subject: string, message: string) {
    await Promise.all([this.sendSlack(subject, message), this.sendEmail(subject, message)]);
  }

  private async sendSlack(subject: string, message: string) {
    if (!this.slack) return;
    try {
      await this.slack.send({
        text: `*${subject}*\n${message}`,
      });
    } catch (error) {
      console.error("Failed to send Slack notification", error);
    }
  }

  private async sendEmail(subject: string, message: string) {
    if (!this.emailTransporter) return;
    const config = loadConfig();
    if (!config.notifications.email) return;

    try {
      await this.emailTransporter.sendMail({
        from: config.notifications.email.from,
        to: config.notifications.email.to,
        subject,
        text: message,
      });
    } catch (error) {
      console.error("Failed to send email notification", error);
    }
  }
}

const TRADE_LOG_PATH = path.join(process.cwd(), "data", "tradeLog.json");

const ensureTradeLog = async () => {
  try {
    await fs.access(TRADE_LOG_PATH);
  } catch {
    await fs.mkdir(path.dirname(TRADE_LOG_PATH), { recursive: true });
    await fs.writeFile(TRADE_LOG_PATH, JSON.stringify([], null, 2));
  }
};

const appendTradeLog = async (entries: Array<Record<string, unknown>>) => {
  await ensureTradeLog();
  const current = JSON.parse(await fs.readFile(TRADE_LOG_PATH, "utf-8")) as Array<Record<string, unknown>>;
  current.push(...entries);
  await fs.writeFile(TRADE_LOG_PATH, JSON.stringify(current, null, 2));
};

const parseWatchlist = (): string[] => {
  const raw = process.env.WATCHLIST_SYMBOLS ?? "SPY,QQQ,IWM";
  return raw
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);
};

const executeAutoTrader = async (client?: IBKRClient): Promise<AutoTraderResult> => {
  const config = loadConfig();
  const ibkrClient = client ?? new IBKRClient(config.ibkr);
  const scanner = new VolatilityScanner(config.newsApiKey);
  const strategy = new StrategyEngine(config.risk);
  const notifier = new NotificationDispatcher();

  await ibkrClient.authenticate();

  try {
    const [account, positions] = await Promise.all([
      ibkrClient.getAccountCapital(),
      ibkrClient.getOpenPositions(),
    ]);

    const signals = await scanner.scan(parseWatchlist());
    const proposals = strategy.generateProposals(signals, account, positions);

    if (!proposals.length) {
      await notifier.send(
        "Auto-trader update",
        "No qualifying volatility opportunities were found for this cycle.",
      );
      return { proposals: [], executedOrders: [] };
    }

    const executions: Array<{ symbol: string; orderId: number; estimatedCost: number }> = [];

    for (const proposal of proposals) {
      for (const order of proposal.orders) {
        const orderId = await placeOrderSafe(ibkrClient, order);
        executions.push({
          symbol: proposal.symbol,
          orderId,
          estimatedCost: proposal.estimatedCost,
        });
      }
    }

    await appendTradeLog(
      executions.map((execution) => ({
        timestamp: new Date().toISOString(),
        ...execution,
      })),
    );

    const summary = executions
      .map((execution) => `#${execution.orderId} ${execution.symbol} ~$${execution.estimatedCost.toFixed(2)}`)
      .join("\n");

    await notifier.send(
      "Auto-trader orders submitted",
      `Submitted ${executions.length} orders:\n${summary}`,
    );

    return { proposals, executedOrders: executions };
  } finally {
    if (!client) {
      ibkrClient.disconnect();
    }
  }
};

const placeOrderSafe = async (client: IBKRClient, order: TradeOrder): Promise<number> => {
  try {
    return await client.placeOrder(order);
  } catch (error) {
    console.error("Failed to place order", error);
    throw error;
  }
};

export const createAutoTraderWorkflow = async () => {
  const mastraModule = await import("mastra").catch(() => ({} as any));
  const runner = async () => executeAutoTrader();

  if (typeof mastraModule.createWorkflow === "function") {
    return mastraModule.createWorkflow({
      id: "autoTrader",
      run: runner,
    });
  }

  if (typeof mastraModule.workflow === "function") {
    return mastraModule.workflow({
      id: "autoTrader",
      run: runner,
    });
  }

  if (typeof mastraModule.Workflow === "function") {
    return new mastraModule.Workflow({
      id: "autoTrader",
      run: runner,
    });
  }

  return {
    id: "autoTrader",
    run: runner,
  };
};

export type AutoTraderWorkflow = Awaited<ReturnType<typeof createAutoTraderWorkflow>>;
