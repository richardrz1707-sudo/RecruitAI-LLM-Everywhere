import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
} from 'recharts'

export default function ScoreRadar({ scoreJson }) {
  const data = [
    { dimension: 'Hard Skills', score: scoreJson?.hard_skills_match?.score ?? 0 },
    { dimension: 'Experience', score: scoreJson?.experience_fit?.score ?? 0 },
    { dimension: 'Education', score: scoreJson?.education_alignment?.score ?? 0 },
    { dimension: 'Soft Skills', score: scoreJson?.soft_skills_signals?.score ?? 0 },
    { dimension: 'Industry', score: scoreJson?.industry_relevance?.score ?? 0 },
    { dimension: 'Trajectory', score: scoreJson?.career_trajectory?.score ?? 0 },
  ]

  return (
    <RadarChart width={280} height={220} data={data}>
      <PolarGrid />
      <PolarAngleAxis dataKey="dimension" tick={{ fontSize: 11 }} />
      <Radar
        name="Score"
        dataKey="score"
        stroke="#1D9E75"
        fill="#1D9E75"
        fillOpacity={0.6}
      />
    </RadarChart>
  )
}
