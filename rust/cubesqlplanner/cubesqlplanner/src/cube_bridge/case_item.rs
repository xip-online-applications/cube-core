use super::case_label::CaseLabel;
use super::member_sql::{MemberSql, NativeMemberSql};
use cubenativeutils::wrappers::serializer::{
    NativeDeserialize, NativeDeserializer, NativeSerialize,
};
use cubenativeutils::wrappers::NativeContextHolder;
use cubenativeutils::wrappers::NativeObjectHandle;
use cubenativeutils::CubeError;
use std::any::Any;
use std::rc::Rc;

#[nativebridge::native_bridge]
pub trait CaseItem {
    #[nbridge(field)]
    fn sql(&self) -> Result<Rc<dyn MemberSql>, CubeError>;
    #[nbridge(field)]
    fn label(&self) -> Result<CaseLabel, CubeError>;
}
