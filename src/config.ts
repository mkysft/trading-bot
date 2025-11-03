export interface IBKRCredentials {
  host: string;
  port: number;
  clientId: number;
  account?: string;
  paperTrading: boolean;
}

export interface SchedulerConfig {
  cadence: string;
}

export interface NotificationConfig {
  slackWebhookUrl?: string;
  email?: {
    from: string;
    to: string;
    smtpHost: string;
    smtpPort: number;
    user?: string;
    password?: string;
  };
}

export interface RiskConfig {
  maxCapitalPerTrade: number;
  maxOpenPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}

export interface AppConfig {
  ibkr: IBKRCredentials;
  scheduler: SchedulerConfig;
  notifications: NotificationConfig;
  risk: RiskConfig;
  newsApiKey?: string;
}

const toNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (typeof value === "undefined") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

let cachedConfig: AppConfig | undefined;

export const loadConfig = (): AppConfig => {
  if (cachedConfig) {
    return cachedConfig;
  }

  const ibkrHost = process.env.IBKR_HOST ?? "127.0.0.1";
  const ibkrPort = toNumber(process.env.IBKR_PORT, 7497);
  const clientId = toNumber(process.env.IBKR_CLIENT_ID, 1);

  const schedulerCadence = process.env.TRADING_CADENCE ?? "0 * * * *"; // hourly by default

  const notifications: NotificationConfig = {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  };

  if (process.env.EMAIL_FROM && process.env.EMAIL_TO && process.env.SMTP_HOST) {
    notifications.email = {
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      smtpHost: process.env.SMTP_HOST,
      smtpPort: toNumber(process.env.SMTP_PORT, 465),
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
    };
  }

  cachedConfig = {
    ibkr: {
      host: ibkrHost,
      port: ibkrPort,
      clientId,
      account: process.env.IBKR_ACCOUNT,
      paperTrading: toBoolean(process.env.IBKR_PAPER, true),
    },
    scheduler: {
      cadence: schedulerCadence,
    },
    notifications,
    risk: {
      maxCapitalPerTrade: toNumber(process.env.MAX_CAPITAL_PER_TRADE, 1000),
      maxOpenPositions: toNumber(process.env.MAX_OPEN_POSITIONS, 5),
      stopLossPercent: toNumber(process.env.STOP_LOSS_PERCENT, 20),
      takeProfitPercent: toNumber(process.env.TAKE_PROFIT_PERCENT, 30),
    },
    newsApiKey: process.env.NEWS_API_KEY,
  };

  return cachedConfig;
};

export const resetConfig = () => {
  cachedConfig = undefined;
};
