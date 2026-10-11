import express from "express";

const app = express();

app.use(express.json());

const API_BASE_PATH = "/api/eventRelay";

app.get(`${API_BASE_PATH}/health`, (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "EventRelay",
  });
});

export default app;