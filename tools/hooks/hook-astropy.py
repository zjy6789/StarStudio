"""Collect scientific Astropy modules without importing optional plotting/tests.

The default PyInstaller hook imports all subpackages. Astropy 8 wcsaxes raises
pytest's Skipped exception if Matplotlib is absent in a development environment.
Neither plotting nor Astropy's test suite is used by the processing component.
"""
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

hiddenimports = collect_submodules('astropy',filter=lambda name:
    'tests' not in name.split('.') and not name.startswith('astropy.visualization'))
hiddenimports += ['numpy.lib.recfunctions']
datas = collect_data_files('astropy',excludes=['**/tests/**'])
datas += [(path,target) for path,target in collect_data_files('astropy',include_py_files=True)
          if path.endswith(('_parsetab.py','_lextab.py'))]
datas += copy_metadata('astropy') + copy_metadata('numpy')
excludedimports = ['astropy.visualization']
