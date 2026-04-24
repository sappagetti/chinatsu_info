/**
 * 북마크릿 ingest 페이로드 중 scores[] 행 형식
 */

/** music-ex.json の1曲（フィールドは 문자열로 정규化되어 전달） */
export type MusicExTrack = Record<string, string>;

export type IngestScoreRow = {
  name: string;
  difficulty: string;
  level: string;
  genre: string;
  technicalHighScore: number;
  overDamageHighScore: number;
  battleHighScore: number;
  fullBell: boolean;
  fullCombo?: boolean;
  allBreak: boolean;
  const?: number;
  platinumHighScore: number;
  platinumStar: number;
  platinumMaxScore: number;
  character?: string;
  version?: string;
  /** music_catalog の id と対応（タイトル一致で結合できたとき） */
  music_ex_id?: string;
};

