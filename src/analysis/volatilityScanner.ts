import { loadConfig } from "@config";

type NewsArticle = {
  title: string;
  description?: string;
  url: string;
  publishedAt?: string;
};

export interface MarketSignal {
  symbol: string;
  impliedVolatility: number;
  historicalVolatility: number;
  catalysts: string[];
  sentimentScore: number;
  lastPrice: number;
}

const computeHistoricalVolatility = (prices: number[]): number => {
  if (prices.length < 2) return 0;
  const returns = [] as number[];
  for (let i = 1; i < prices.length; i += 1) {
    const prev = prices[i - 1];
    const curr = prices[i];
    returns.push(Math.log(curr / prev));
  }
  const avg = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(252); // annualized
};

const scoreSentiment = (articles: NewsArticle[]): number => {
  if (!articles.length) return 0;
  const positiveKeywords = ["beat", "surge", "upgrade", "record", "growth"];
  const negativeKeywords = ["miss", "downgrade", "lawsuit", "decline", "halt"];

  let score = 0;
  for (const article of articles) {
    const text = `${article.title} ${article.description ?? ""}`.toLowerCase();
    for (const keyword of positiveKeywords) {
      if (text.includes(keyword)) {
        score += 1;
      }
    }
    for (const keyword of negativeKeywords) {
      if (text.includes(keyword)) {
        score -= 1;
      }
    }
  }

  return score / articles.length;
};

export class VolatilityScanner {
  constructor(private readonly newsApiKey = loadConfig().newsApiKey) {}

  async scan(symbols: string[]): Promise<MarketSignal[]> {
    const results: MarketSignal[] = [];

    for (const symbol of symbols) {
      const [articles, prices] = await Promise.all([
        this.fetchNews(symbol),
        this.fetchHistoricalPrices(symbol),
      ]);

      const sentiment = scoreSentiment(articles);
      const historicalVolatility = computeHistoricalVolatility(prices);
      const impliedVolatility = historicalVolatility * (1 + Math.max(sentiment, 0));
      const lastPrice = prices.at(-1) ?? 0;

      results.push({
        symbol,
        impliedVolatility,
        historicalVolatility,
        catalysts: articles.slice(0, 3).map((article) => article.title),
        sentimentScore: sentiment,
        lastPrice,
      });
    }

    return results;
  }

  private async fetchNews(symbol: string): Promise<NewsArticle[]> {
    if (!this.newsApiKey) {
      return [
        {
          title: `${symbol} - market overview`,
          description: "News API key not configured; using placeholder data.",
          url: "https://example.com",
        },
      ];
    }

    const params = new URLSearchParams({
      q: symbol,
      language: "en",
      sortBy: "publishedAt",
      pageSize: "5",
      apiKey: this.newsApiKey,
    });

    try {
      const response = await fetch(`https://newsapi.org/v2/everything?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`News API request failed with status ${response.status}`);
      }
      const json = await response.json();
      return (json.articles ?? []).map((article: any) => ({
        title: article.title,
        description: article.description,
        url: article.url,
        publishedAt: article.publishedAt,
      }));
    } catch (error) {
      console.error(`Failed to fetch news for ${symbol}`, error);
      return [
        {
          title: `${symbol} - fallback news`,
          description: "Error fetching news; using fallback signal.",
          url: "https://example.com",
        },
      ];
    }
  }

  private async fetchHistoricalPrices(symbol: string): Promise<number[]> {
    try {
      const query = new URLSearchParams({
        symbols: symbol,
        range: "1mo",
        interval: "1d",
      });
      const response = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/spark?${query.toString()}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch historical prices: ${response.status}`);
      }

      const json = await response.json();
      const series = json.spark?.result?.[0]?.response?.[0]?.indicators?.quote?.[0]?.close;
      if (Array.isArray(series) && series.length > 0) {
        return series.filter((value: number | null) => typeof value === "number");
      }
    } catch (error) {
      console.error(`Failed to fetch price history for ${symbol}`, error);
    }

    // fallback synthetic series
    const fallback: number[] = [];
    let price = 100;
    for (let i = 0; i < 20; i += 1) {
      price *= 1 + (Math.random() - 0.5) / 50;
      fallback.push(Number(price.toFixed(2)));
    }
    return fallback;
  }
}
