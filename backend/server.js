const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Wind turbine physics constants
const RHO = 1.225;       // Air density kg/m³
const AREA = Math.PI;    // Swept area m² (radius = 1m)
const CP = 0.35;         // Power coefficient (Betz limit is 0.593)
const CUT_IN = 2.5;      // Cut-in wind speed m/s
const CUT_OUT = 25;      // Cut-out wind speed m/s
const RATED_POWER = 3500; // Rated power cap in Watts

function computePower(windSpeed) {
  if (windSpeed < CUT_IN || windSpeed > CUT_OUT) return 0;
  if (windSpeed > 15) return RATED_POWER;
  return parseFloat((0.5 * RHO * AREA * CP * Math.pow(windSpeed, 3)).toFixed(2));
}

function computeEfficiency(windSpeed) {
  if (windSpeed < CUT_IN) return 0;
  if (windSpeed >= 12) return 59;
  return Math.min(59, parseFloat((CP / 0.593 * 100 * (1 - Math.exp(-windSpeed / 5))).toFixed(1)));
}

// GET /api/wind?lat=13.08&lon=80.27
// Default coords: Chennai, India
app.get("/api/wind", async (req, res) => {
  const lat = parseFloat(req.query.lat) || 13.08;
  const lon = parseFloat(req.query.lon) || 80.27;
  const locationName = req.query.location || "Chennai";

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,visibility&wind_speed_unit=ms&timezone=auto`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo responded with ${response.status}`);

    const data = await response.json();
    const current = data.current;

    const windSpeed = current.wind_speed_10m;
    const temperature = current.temperature_2m;
    const humidity = current.relative_humidity_2m;
    const pressure = current.surface_pressure;
    const windDirection = current.wind_direction_10m;
    const windGusts = current.wind_gusts_10m;
    const weatherCode = current.weather_code;
    const visibility = current.visibility ? (current.visibility / 1000).toFixed(1) : null;

    const power = computePower(windSpeed);
    const efficiency = computeEfficiency(windSpeed);

    res.json({
      success: true,
      location: {
        name: locationName,
        lat,
        lon,
        timezone: data.timezone,
      },
      weather: {
        windSpeed,
        windDirection,
        windGusts,
        temperature,
        humidity,
        pressure,
        weatherCode,
        visibility,
        description: getWeatherDescription(weatherCode),
        timestamp: current.time,
      },
      turbine: {
        power,
        efficiency,
        status: getTurbineStatus(windSpeed),
        constants: {
          cutIn: CUT_IN,
          cutOut: CUT_OUT,
          ratedPower: RATED_POWER,
          cp: CP,
          rho: RHO,
          area: AREA,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching weather:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// GET /api/forecast?lat=13.08&lon=80.27
// Returns hourly wind forecast for next 24 hours
app.get("/api/forecast", async (req, res) => {
  const lat = parseFloat(req.query.lat) || 13.08;
  const lon = parseFloat(req.query.lon) || 80.27;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,wind_speed_10m,wind_direction_10m&wind_speed_unit=ms&timezone=auto&forecast_days=1`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Open-Meteo responded with ${response.status}`);

    const data = await response.json();
    const hourly = data.hourly;

    const forecast = hourly.time.map((time, i) => {
      const wind = hourly.wind_speed_10m[i];
      return {
        time,
        windSpeed: wind,
        temperature: hourly.temperature_2m[i],
        power: computePower(wind),
        efficiency: computeEfficiency(wind),
      };
    });

    res.json({ success: true, forecast });
  } catch (error) {
    console.error("Error fetching forecast:", error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

function getTurbineStatus(windSpeed) {
  if (windSpeed < CUT_IN) return "idle";
  if (windSpeed > CUT_OUT) return "shutdown";
  if (windSpeed >= 12) return "rated";
  return "active";
}

// WMO weather code descriptions
function getWeatherDescription(code) {
  const codes = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Moderate drizzle",
    55: "Dense drizzle", 61: "Slight rain", 63: "Moderate rain", 65: "Heavy rain",
    71: "Light snow", 73: "Moderate snow", 75: "Heavy snow",
    80: "Slight showers", 81: "Moderate showers", 82: "Heavy showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Heavy thunderstorm",
  };
  return codes[code] || "Unknown";
}

app.listen(PORT, () => {
  console.log(`WindCore backend running at http://localhost:${PORT}`);
  console.log(`Try: http://localhost:${PORT}/api/wind?lat=13.08&lon=80.27`);
});
