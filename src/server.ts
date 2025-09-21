import express from 'express';
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 3000;
const tokensPath = path.join(__dirname, "../tokens.json");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// точка входа при установке
app.get("/install", (req, res) => {
  const { domain, member_id, AUTH_ID, REFRESH_ID, expires } = req.query;

  if (!domain || !AUTH_ID) {
    res.status(400).send("Invalid install request");
    return;
  }

  const tokens = {
    domain,
    access_token: AUTH_ID,
    refresh_token: REFRESH_ID,
    expires_in: expires,
    member_id,
    received_at: Date.now(),
  };

  fs.writeFileSync(tokensPath, JSON.stringify(tokens, null, 2));
  res.send("Установка завершена, токены сохранены.");
});

app.listen(PORT, () => {
  console.log(`Bitrix local app listening on http://localhost:${PORT}`);
});
