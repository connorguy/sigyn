use crate::{error::AppError, store::Store};

#[cfg(target_os = "macos")]
pub fn authenticate_unlock() -> Result<(), AppError> {
    auth::authenticate_unlock()
}

#[cfg(target_os = "macos")]
pub fn load_master_key() -> Result<Option<Vec<u8>>, AppError> {
    keychain::load_master_key()
}

#[cfg(target_os = "macos")]
pub fn create_master_key() -> Result<Vec<u8>, AppError> {
    keychain::create_master_key()
}

pub fn authenticate_and_load_master_key(store: &Store) -> Result<Vec<u8>, AppError> {
    authenticate_unlock()?;
    load_or_create_master_key(store)
}

pub fn load_or_create_master_key(store: &Store) -> Result<Vec<u8>, AppError> {
    match load_master_key()? {
        Some(key) => Ok(key),
        None => {
            if store.has_encrypted_entries()? {
                return Err(AppError::Auth(
                    "no master key was found for existing encrypted data — restore the previous keychain item or clear the local test data".into(),
                ));
            }
            create_master_key()
        }
    }
}

#[cfg(not(target_os = "macos"))]
compile_error!("sigyn requires macOS — device authentication is not implemented for other platforms");

#[cfg(target_os = "macos")]
mod auth {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::{
        rc::{autoreleasepool, Retained},
        runtime::Bool,
    };
    use objc2_foundation::{NSError, NSString};
    use objc2_local_authentication::{LAContext, LAError, LAPolicy};

    use crate::error::AppError;

    pub(super) fn authenticate_unlock() -> Result<(), AppError> {
        autoreleasepool(|_| {
            let context = unsafe { LAContext::new() };
            let reason = NSString::from_str("unlock sigyn and access stored secrets");

            unsafe {
                context
                    .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
                    .map_err(map_preflight_error)?;
            }

            let (tx, rx) = mpsc::sync_channel(1);
            let reply = RcBlock::new(move |success: Bool, error: *mut NSError| {
                let result = if success.as_bool() {
                    Ok(())
                } else {
                    Err(map_callback_error(error))
                };
                let _ = tx.send(result);
            });

            unsafe {
                context.evaluatePolicy_localizedReason_reply(
                    LAPolicy::DeviceOwnerAuthentication,
                    &reason,
                    &reply,
                );
            }

            let result = rx
                .recv()
                .map_err(|_| AppError::Auth("authentication did not return a result".into()))?;

            unsafe {
                context.invalidate();
            }

            result.map_err(AppError::Auth)
        })
    }

    fn map_preflight_error(error: Retained<NSError>) -> AppError {
        AppError::Auth(map_error_message(&error))
    }

    fn map_callback_error(error: *mut NSError) -> String {
        if error.is_null() {
            return "authentication failed".into();
        }

        let error = unsafe { &*error };
        map_error_message(error)
    }

    fn map_error_message(error: &NSError) -> String {
        match error.code() {
            code if code == LAError::UserCancel.0 => "unlock canceled".into(),
            code if code == LAError::SystemCancel.0 => "unlock was interrupted by macOS".into(),
            code if code == LAError::AppCancel.0 => "unlock was canceled by the app".into(),
            code if code == LAError::BiometryNotEnrolled.0 => {
                "Touch ID is not set up on this Mac".into()
            }
            code if code == LAError::PasscodeNotSet.0 => {
                "password authentication is unavailable because no device password is set".into()
            }
            _ => error.to_string(),
        }
    }
}

#[cfg(target_os = "macos")]
mod keychain {
    use std::ffi::c_void;
    use std::ptr;

    use core_foundation::{
        base::TCFType,
        boolean::CFBoolean,
        data::{CFData, CFDataRef},
        dictionary::{CFDictionaryRef, CFMutableDictionary},
        string::CFString,
    };
    use security_framework_sys::{
        base::errSecItemNotFound,
        item::{kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecReturnData, kSecValueData},
        keychain_item::{SecItemAdd, SecItemCopyMatching},
    };

    use crate::error::AppError;

    const SERVICE: &str = "sigyn";
    const ACCOUNT: &str = "master-key";
    const KEY_SIZE: usize = 32;

    pub(super) fn load_master_key() -> Result<Option<Vec<u8>>, AppError> {
        read_from_keychain()
    }

    pub(super) fn create_master_key() -> Result<Vec<u8>, AppError> {
        let key: [u8; KEY_SIZE] = rand::random();
        write_to_keychain(&key)?;
        Ok(key.to_vec())
    }

    fn read_from_keychain() -> Result<Option<Vec<u8>>, AppError> {
        let mut query = base_query();
        let cf_true = CFBoolean::true_value();
        unsafe {
            query.add(
                &(kSecReturnData as *const c_void),
                &cf_true.as_CFTypeRef(),
            );
        }

        let mut result = ptr::null();
        let status = unsafe { SecItemCopyMatching(as_dict_ref(&mut query), &mut result) };

        match status {
            0 => {
                let data = unsafe { CFData::wrap_under_create_rule(result as CFDataRef) };
                Ok(Some(data.bytes().to_vec()))
            }
            s if s == errSecItemNotFound => Ok(None),
            _ => Err(keychain_error(status)),
        }
    }

    fn write_to_keychain(key: &[u8]) -> Result<(), AppError> {
        let key_data = CFData::from_buffer(key);

        let mut attrs = base_query();
        unsafe {
            attrs.add(
                &(kSecValueData as *const c_void),
                &(key_data.as_concrete_TypeRef() as *const c_void),
            );
        }

        let status = unsafe { SecItemAdd(as_dict_ref(&mut attrs), ptr::null_mut()) };
        if status != 0 {
            return Err(keychain_error(status));
        }

        Ok(())
    }

    fn base_query() -> CFMutableDictionary {
        let service = CFString::new(SERVICE);
        let account = CFString::new(ACCOUNT);

        let mut dict = CFMutableDictionary::new();
        unsafe {
            dict.add(
                &(kSecClass as *const c_void),
                &(kSecClassGenericPassword as *const c_void),
            );
            dict.add(
                &(kSecAttrService as *const c_void),
                &(service.as_concrete_TypeRef() as *const c_void),
            );
            dict.add(
                &(kSecAttrAccount as *const c_void),
                &(account.as_concrete_TypeRef() as *const c_void),
            );
        }
        dict
    }

    fn as_dict_ref(dict: &mut CFMutableDictionary) -> CFDictionaryRef {
        dict.as_concrete_TypeRef() as CFDictionaryRef
    }

    fn keychain_error(status: i32) -> AppError {
        let message = match status {
            -128 => "unlock canceled".to_string(),
            -34018 => {
                "keychain access is missing the entitlements required for the data protection keychain"
                    .to_string()
            }
            -25293 => "authentication failed".to_string(),
            _ => format!("keychain operation failed (OSStatus {status})"),
        };
        AppError::Auth(message)
    }
}
