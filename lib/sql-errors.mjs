// Pure classifier for one specific SQL Server error, so execute_procedure
// can tell "you don't have EXECUTE permission" apart from every other
// failure (bad parameter name, procedure doesn't exist, network error, ...)
// and only append fallback guidance for that one case.
//
// The worker surfaces .NET's SqlException.Message text, not the numeric
// error number, so this matches on SQL Server's fixed wording for error 229
// ("The EXECUTE permission was denied on the object '<name>', database
// '<db>', schema '<schema>'.") rather than trying to parse a structured code.
export function isExecutePermissionDenied(message) {
  return typeof message === 'string' && /EXECUTE permission was denied/i.test(message);
}
