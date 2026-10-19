import { Router, type IRouter } from "express";

const router: IRouter = Router();

// Keep the upstream fixed so this endpoint cannot be used as an arbitrary
// server-side request proxy. This OpenStreetMap mirror does not require an
// application API key and supports the zoom levels used by the map.
const TILE_ORIGIN = "https://tile.openstreetmap.de";

router.get("/map-tiles/:z/:x/:y.png", async (req, res): Promise<void> => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  const validInteger = (value: number): boolean => Number.isInteger(value) && value >= 0;

  if (!validInteger(z) || z > 19 || !validInteger(x) || !validInteger(y) || x >= 2 ** z || y >= 2 ** z) {
    res.status(400).json({ error: "Nieprawidłowe współrzędne kafelka mapy." });
    return;
  }

  try {
    const response = await fetch(`${TILE_ORIGIN}/${z}/${x}/${y}.png`, {
      headers: { "user-agent": "Pysne.com.pl map tile proxy" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      res.status(502).json({ error: "Nie udało się pobrać kafelka mapy." });
      return;
    }

    res.setHeader("Content-Type", response.headers.get("content-type") ?? "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.status(502).json({ error: "Nie udało się pobrać kafelka mapy." });
  }
});

export default router;
