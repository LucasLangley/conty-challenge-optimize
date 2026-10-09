import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CountRow = { n: number };

// Criadores com score > 0. O score conta cada par (nicho da campanha, nicho do
// criador) igual, como o laço duplo original: nicho repetido conta de novo.
// O parâmetro é o niches_json da campanha.
const SCORED_CTE = `
scored AS (
  SELECT c.id, c.name, COUNT(*) AS niche_score
  FROM creators AS c
  JOIN json_each(c.niches_json) AS creator_niche
  JOIN json_each(?) AS campaign_niche ON campaign_niche.value = creator_niche.value
  GROUP BY c.id
)`;

// Uma query para a página inteira: alcance da métrica mais recente de cada conta
// (captured_at desc, empate por id desc), ordem e paginação no SQL, e entregas
// dos 90 dias só para as linhas da página.
const PAGE_SQL = `
WITH ${SCORED_CTE},
latest_metric AS (
  SELECT account_id, views,
    ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY captured_at DESC, id DESC) AS rn
  FROM metrics
),
reach AS (
  SELECT account.creator_id, SUM(latest_metric.views) AS latest_reach
  FROM social_accounts AS account
  JOIN latest_metric ON latest_metric.account_id = account.id AND latest_metric.rn = 1
  GROUP BY account.creator_id
),
page AS (
  SELECT scored.id, scored.name, scored.niche_score,
    COALESCE(reach.latest_reach, 0) AS latest_reach
  FROM scored
  LEFT JOIN reach ON reach.creator_id = scored.id
  ORDER BY scored.niche_score DESC, latest_reach DESC, scored.id ASC
  LIMIT ? OFFSET ?
)
SELECT page.id, page.name, page.niche_score, page.latest_reach,
  (SELECT COUNT(*) FROM deliveries
    WHERE deliveries.creator_id = page.id AND deliveries.delivered_at >= ?) AS deliveries_90d
FROM page
ORDER BY page.niche_score DESC, page.latest_reach DESC, page.id ASC`;

const TOTAL_SQL = `WITH ${SCORED_CTE} SELECT COUNT(*) AS n FROM scored`;

export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const total = await get<CountRow>(db, TOTAL_SQL, campaign.niches_json);
  const rows = await all<CreatorMatch>(
    db,
    PAGE_SQL,
    campaign.niches_json,
    BigInt(input.limit),
    BigInt(input.offset),
    deliveriesSince(),
  );

  return {
    campaign_id: input.campaignId,
    total: Number(total?.n ?? 0),
    creators: rows.map((row) => ({
      id: row.id,
      name: row.name,
      niche_score: Number(row.niche_score),
      latest_reach: Number(row.latest_reach),
      deliveries_90d: Number(row.deliveries_90d),
    })),
  };
}
