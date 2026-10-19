/**
 * Why a plugin change did not happen, as a row, the apply bar, the page and a notice card say it:
 * the sentence in the language of the UI (`problemText`), and Rust's own message after it where
 * there is one (`problemDetail`). That message is English whatever the language, so it says so
 * (`lang`), as Updates does with a tool's reason.
 */

import { useTranslation } from 'react-i18next';

import { problemDetail, problemText, type PluginProblem } from './problem';

export interface ProblemTextProps {
  problem: PluginProblem;
}

export default function ProblemText({ problem }: ProblemTextProps) {
  const { t } = useTranslation();
  const detail = problemDetail(problem);

  return (
    <>
      {problemText(problem, t)}
      {detail !== null && (
        <>
          {' '}
          <span lang="en">{detail}</span>
        </>
      )}
    </>
  );
}
