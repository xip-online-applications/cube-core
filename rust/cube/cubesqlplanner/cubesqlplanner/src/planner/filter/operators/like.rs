/// `Like` filter operation: substring, prefix or suffix match
/// (negated for the `not_*` variants).
///
/// `case_insensitive_upper` selects how case-insensitivity is achieved:
/// when `false` (the default for `contains`/`startsWith`/`endsWith` and
/// their negations) the native `ILIKE` operator is used; when `true`
/// (only for `iStartsWith`) `LIKE` is used against `UPPER()`-wrapped
/// column and value expressions instead, since plain `ILIKE` can defeat
/// index usage on some drivers.
#[derive(Clone, Debug)]
pub struct LikeOp {
    pub(crate) negated: bool,
    pub(crate) start_wild: bool,
    pub(crate) end_wild: bool,
    pub(crate) values: Vec<String>,
    pub(crate) has_null: bool,
    pub(crate) member_type: Option<String>,
    pub(crate) case_insensitive_upper: bool,
}

impl LikeOp {
    pub fn new(
        negated: bool,
        start_wild: bool,
        end_wild: bool,
        values: Vec<String>,
        has_null: bool,
        member_type: Option<String>,
        case_insensitive_upper: bool,
    ) -> Self {
        Self {
            negated,
            start_wild,
            end_wild,
            values,
            has_null,
            member_type,
            case_insensitive_upper,
        }
    }
}
