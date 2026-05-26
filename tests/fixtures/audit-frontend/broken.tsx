// Deliberately broken JSX — exercises the parse-failure path in audit-frontend.
// `ts.createSourceFile` will surface a diagnostic in parseDiagnostics.
import * as React from 'react';

export function Broken() {
  return <div>missing closing tag
}
