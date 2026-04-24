// 랜딩/설명 페이지. 본문은 일본어(엔드유저용).
// 로그인 상태에 따라 표시하는 메뉴 설명을 분기한다.
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function HomePage() {
  const { user } = useAuth();

  return (
    <article className="prose">
      <h1>Chinatsu Info へようこそ</h1>
      <p className="muted">
        オンゲキNETで取得した自分の成績データを、見やすく整理して確認するための非公式ファンメイドサイトです。
      </p>
      {user ? <AuthedMenuGuide /> : <GuestMenuGuide />}
      <p className="muted">
        非公式ファンメイドとして運営しています。詳細は <Link to="/policy">運営ポリシー</Link> をご確認ください。
      </p>
    </article>
  );
}

// 비로그인 방문자용: 상단에 실제로 보이는 메뉴(会員登録 / ログイン / 楽曲データ)만 안내한다.
function GuestMenuGuide() {
  return (
    <>
      <h2>はじめに</h2>
      <p>
        利用にはアカウントが必要です。まずは <Link to="/signup">会員登録</Link> または{" "}
        <Link to="/login">ログイン</Link> を行ってください。ログイン後にブックマークレット発行や成績データの同期機能が利用できます。
      </p>
      <h2>メニュー</h2>
      <ul>
        <li>
          <strong>
            <Link to="/signup">会員登録</Link>
          </strong>
          : メールアドレスとパスワードで新規アカウントを作成します。
        </li>
        <li>
          <strong>
            <Link to="/login">ログイン</Link>
          </strong>
          : 既存アカウントでログインします。ログイン保持も選べます。
        </li>
        <li>
          <strong>
            <Link to="/songs">楽曲データ</Link>
          </strong>
          : ログインなしで閲覧できる楽曲カタログです。難易度・レベル・ジャケットから曲を探せます。
        </li>
      </ul>
    </>
  );
}

// 로그인 사용자용: 실제로 보이는 기능 메뉴 6종을 설명한다.
function AuthedMenuGuide() {
  return (
    <>
      <h2>メニュー</h2>
      <ul>
        <li>
          <strong>
            <Link to="/setup">ブックマーク</Link>
          </strong>
          : 自分専用のブックマークレットURLを発行し、オンゲキNET上で実行してデータを同期します。
        </li>
        <li>
          <strong>
            <Link to="/rating">レーティング対象</Link>
          </strong>
          : 現在のスコアからレーティング対象曲と寄与値を確認できます。
        </li>
        <li>
          <strong>
            <Link to="/achievement">レコード</Link>
          </strong>
          : レベル帯ごとに達成状況とレートを一覧で確認できます。
        </li>
        <li>
          <strong>
            <Link to="/rating-sim">目標計算</Link>
          </strong>
          : 目標スコアを入力して、レーティング変化をシミュレーションできます。
        </li>
        <li>
          <strong>
            <Link to="/songs">楽曲データ</Link>
          </strong>
          : 難易度・レベル・ジャケットから曲を検索できる楽曲カタログです。
        </li>
        <li>
          <strong>
            <Link to="/account">プロフィール</Link>
          </strong>
          : アカウント情報やゲームプロフィールカードを確認・管理できます。
        </li>
      </ul>
    </>
  );
}
