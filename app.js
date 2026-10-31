import express from "express";
import apiRoutes from "./routes/index.js";

const app = express();

app.use(express.json({ limit: "256kb" }));


// Health check
app.get("/api/eventRelay/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "EventRelay",
  });
});

// Main API routes
app.use("/api/eventRelay", apiRoutes);



app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "Payload too large",
      message: "Request body must not exceed 256 KB.",
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({
      error: "Invalid JSON",
      message: "Request body must contain valid JSON.",
    });
  }

  next(err);
});

export default app;
