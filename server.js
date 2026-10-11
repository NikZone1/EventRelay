import app from "./app.js";
import { env } from "./env.js";

app.listen(env.port, () => {
  console.log(`EventRelay running on port ${env.port}`);
});