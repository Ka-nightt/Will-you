// Local development: npm run dev
const app = require('./app');
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`💖 Running on http://localhost:${PORT}  (admin: /#admin)`));
